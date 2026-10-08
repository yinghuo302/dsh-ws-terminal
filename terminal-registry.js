import { isAbsolute } from 'node:path'
import { WebSocket } from 'ws'

const TERMINAL_TYPE = 'xterm-256color'
const OUTPUT_LIMIT = 1024 * 1024
const MAX_PER_SESSION = 8
const RECONNECT_GRACE_MS = 30_000
const SOCKET_BACKPRESSURE_LIMIT = 4 * 1024 * 1024

/** Owns PTYs by (session, sidebar tab), with bounded reconnect replay. */
export class TerminalRegistry {
  #subprocess
  #sessions
  #terminals = new Map()
  #opening = new Map()
  #disposed = false

  constructor({ subprocess, sessions, maxPerSession = MAX_PER_SESSION, reconnectGraceMs = RECONNECT_GRACE_MS }) {
    this.#subprocess = subprocess
    this.#sessions = sessions
    this.maxPerSession = maxPerSession
    this.reconnectGraceMs = reconnectGraceMs
  }

  async attach(socket, sessionId, tabId, cols = 80, rows = 24) {
    if (this.#disposed) throw new Error('terminal plugin is shutting down')
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw new Error('invalid session id')
    if (typeof tabId !== 'string' || !tabId || tabId.length > 256) throw new Error('invalid terminal tab id')
    const session = this.#sessions.get(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) throw new Error('session working directory is unavailable')

    const key = this.#key(sessionId, tabId)
    const terminal = await this.#getOrCreate(key, sessionId, tabId, cwd, clampDimension(cols), clampDimension(rows))
    if (socket.readyState !== WebSocket.OPEN) {
      this.#detach(terminal, socket)
      return
    }
    if (terminal.closeTimer !== undefined) clearTimeout(terminal.closeTimer)
    terminal.closeTimer = undefined
    if (terminal.transcript.length > 0) socket.send(terminal.transcript, { binary: true })
    terminal.sockets.add(socket)
    socket.on('message', data => { void this.#onMessage(terminal, socket, data) })
    socket.on('close', () => this.#detach(terminal, socket))
    socket.on('error', () => this.#detach(terminal, socket))
  }

  async close(sessionId, tabId) {
    const terminal = this.#terminals.get(this.#key(sessionId, tabId))
    if (terminal === undefined) return false
    await this.#destroy(terminal, 'closed')
    return true
  }

  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    await Promise.allSettled([...this.#opening.values()])
    await Promise.all([...this.#terminals.values()].map(terminal => this.#destroy(terminal, 'closed')))
  }

  async #getOrCreate(key, sessionId, tabId, cwd, cols, rows) {
    const live = this.#terminals.get(key)
    if (live !== undefined && !live.closed && live.cwd === cwd) return live
    const pending = this.#opening.get(key)
    if (pending !== undefined) return pending

    const promise = this.#open(key, sessionId, tabId, cwd, cols, rows)
    this.#opening.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.#opening.get(key) === promise) this.#opening.delete(key)
    }
  }

  async #open(key, sessionId, tabId, cwd, cols, rows) {
    const old = this.#terminals.get(key)
    if (old !== undefined) await this.#destroy(old, 'replaced')
    const count = [...this.#terminals.values()].filter(item => item.sessionId === sessionId && !item.closed).length
    const opening = [...this.#opening.keys()].filter(item => item.startsWith(`${sessionId}\u0000`)).length
    if (count + opening >= this.maxPerSession) throw new Error(`terminal limit reached (${this.maxPerSession})`)
    if (this.#subprocess === undefined) throw new Error('host subprocess service is unavailable')

    const environment = await this.#subprocess.terminalEnvironment()
    const shell = environment.defaultShell ?? (environment.platform === 'windows' ? 'powershell.exe' : '/bin/sh')
    const executable = await this.#subprocess.resolveExecutable(shell)
    const argv = environment.platform === 'windows' ? [executable] : [executable, '-l']
    const handle = await this.#subprocess.spawnTerminal({
      argv,
      cwd,
      cols,
      rows,
      terminalType: TERMINAL_TYPE,
      graceMs: this.reconnectGraceMs,
    })
    if (this.#disposed) {
      await handle.terminate()
      throw new Error('terminal plugin is shutting down')
    }
    const terminal = {
      key,
      sessionId,
      tabId,
      cwd,
      handle,
      sockets: new Set(),
      transcript: Buffer.alloc(0),
      closed: false,
      writeQueue: Promise.resolve(),
      closeTimer: undefined,
    }
    this.#terminals.set(key, terminal)
    void this.#pump(terminal)
    void handle.done.then(
      outcome => this.#finish(terminal, outcome),
      error => this.#fail(terminal, error),
    )
    return terminal
  }

  async #pump(terminal) {
    try {
      for await (const chunk of terminal.handle.output) {
        if (terminal.closed) break
        const bytes = Buffer.from(chunk)
        terminal.transcript = appendBounded(terminal.transcript, bytes)
        for (const socket of terminal.sockets) {
          if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < SOCKET_BACKPRESSURE_LIMIT) {
            socket.send(bytes, { binary: true })
          }
        }
      }
    } catch (error) {
      this.#fail(terminal, error)
    }
  }

  async #onMessage(terminal, socket, raw) {
    if (terminal.closed || socket.readyState !== WebSocket.OPEN) return
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    let frame
    try {
      const value = JSON.parse(text)
      if (value !== null && typeof value === 'object') frame = value
    } catch {
      // Plain text frames are terminal keystrokes/paste.
    }
    if (frame?.type === 'close') {
      await this.#destroy(terminal, 'closed')
      return
    }
    if (frame?.type === 'park') return
    if (frame?.type === 'resize') {
      const cols = clampDimension(frame.cols)
      const rows = clampDimension(frame.rows)
      if (cols !== undefined && rows !== undefined) {
        try { await terminal.handle.resize(cols, rows) } catch { /* process may have exited */ }
      }
      return
    }
    terminal.writeQueue = terminal.writeQueue
      .then(() => terminal.handle.write(text))
      .catch(error => this.#fail(terminal, error))
  }

  #detach(terminal, socket) {
    terminal.sockets.delete(socket)
    if (terminal.closed || terminal.sockets.size > 0) return
    if (terminal.closeTimer !== undefined) clearTimeout(terminal.closeTimer)
    terminal.closeTimer = setTimeout(() => { void this.#destroy(terminal, 'disconnected') }, this.reconnectGraceMs)
    terminal.closeTimer.unref?.()
  }

  #finish(terminal, outcome) {
    if (terminal.closed) return
    const message = Buffer.from(`\r\n[process exited with code ${String(outcome?.exitCode ?? null)}]\r\n`)
    terminal.transcript = appendBounded(terminal.transcript, message)
    for (const socket of terminal.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message, { binary: true })
        socket.send(JSON.stringify({ type: 'exit', exitCode: outcome?.exitCode ?? null }))
        socket.close(1000, 'process-exited')
      }
    }
    terminal.sockets.clear()
    terminal.closed = true
    this.#terminals.delete(terminal.key)
  }

  #fail(terminal, error) {
    if (terminal.closed) return
    const message = error instanceof Error ? error.message : String(error)
    for (const socket of terminal.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', message }))
    }
    void this.#destroy(terminal, 'failed')
  }

  async #destroy(terminal, reason) {
    if (terminal.closed) return
    terminal.closed = true
    if (terminal.closeTimer !== undefined) clearTimeout(terminal.closeTimer)
    this.#terminals.delete(terminal.key)
    for (const socket of terminal.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'closed', reason }))
        socket.close(1000, reason)
      }
    }
    terminal.sockets.clear()
    try { await terminal.handle.terminate() } catch { /* teardown is best-effort after ownership removal */ }
  }

  #key(sessionId, tabId) {
    return `${sessionId}\u0000${tabId}`
  }
}

function clampDimension(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  return rounded >= 2 && rounded <= 1024 ? rounded : undefined
}

function appendBounded(previous, next) {
  const combined = Buffer.concat([previous, next])
  return combined.length <= OUTPUT_LIMIT ? combined : combined.subarray(combined.length - OUTPUT_LIMIT)
}
