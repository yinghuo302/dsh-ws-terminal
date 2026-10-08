import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

const h = React.createElement
const TAB_ID = 'dsh-ws-terminal:terminal'
const WS_RECONNECTS = 5

export const inject = ['betterSidebar']

/** Client half: register a normal Better Sidebar page with per-open PTY identity. */
export function apply(ctx) {
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: TAB_ID,
    title: () => 'Terminal',
    description: () => 'Interactive shell over a persistent WebSocket',
    order: 40,
    createTab: () => ({
      tab: {
        id: `ws-terminal:${crypto.randomUUID()}`,
        type: TAB_ID,
        title: 'Terminal',
      },
    }),
    component: TerminalPane,
  }))
}

function TerminalPane({ scope, tab, visible }) {
  const hostRef = useRef(null)
  const emulatorRef = useRef(undefined)
  const socketRef = useRef(undefined)
  const [status, setStatus] = useState('connecting')
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  const retry = useCallback(() => {
    setError('')
    setStatus('connecting')
    setRetryKey(value => value + 1)
  }, [])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    let disposed = false
    let retries = 0
    let timer
    let currentSocket
    let terminalFailure = false

    const computed = getComputedStyle(host)
    const terminal = new Terminal({
      fontFamily: computed.fontFamily || 'monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: computed.backgroundColor,
        foreground: computed.color,
        cursor: computed.color,
        selectionBackground: 'rgba(128, 128, 128, 0.35)',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminal.textarea?.setAttribute('aria-label', 'Terminal')
    emulatorRef.current = terminal

    const fit = () => {
      if (disposed || !visible || host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fitAddon.fit()
        const { cols, rows } = terminal
        if (cols >= 2 && rows >= 2 && currentSocket?.readyState === WebSocket.OPEN) {
          currentSocket.send(JSON.stringify({ type: 'resize', cols, rows }))
        }
      } catch { /* xterm may not have measurable dimensions during first paint */ }
    }

    const connect = () => {
      if (disposed) return
      setStatus(retries === 0 ? 'connecting' : 'disconnected')
      const url = hostRouteUrl('sidebar/ws/dsh-ws-terminal')
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('sessionId', scope.sessionId)
      url.searchParams.set('tab', tab.id)
      url.searchParams.set('cols', String(terminal.cols || 80))
      url.searchParams.set('rows', String(terminal.rows || 24))
      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      currentSocket = socket
      socketRef.current = socket
      socket.onopen = () => {
        retries = 0
        setError('')
        setStatus('connected')
        fit()
        terminal.focus()
      }
      socket.onmessage = event => {
        if (typeof event.data === 'string') {
          try {
            const frame = JSON.parse(event.data)
            if (frame?.type === 'error') {
              terminalFailure = true
              setError(String(frame.message ?? 'Terminal failed'))
              setStatus('failed')
              return
            }
            if (frame?.type === 'exit') {
              setStatus('exited')
              return
            }
            if (frame?.type === 'closed') return
          } catch { /* non-JSON string output is valid PTY output */ }
          terminal.write(event.data)
        } else if (event.data instanceof ArrayBuffer) {
          terminal.write(new Uint8Array(event.data))
        } else if (ArrayBuffer.isView(event.data)) {
          terminal.write(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength))
        }
      }
      socket.onclose = event => {
        if (socketRef.current === socket) socketRef.current = undefined
        if (disposed || event.reason === 'process-exited') {
          if (event.reason === 'process-exited') setStatus('exited')
          return
        }
        if (terminalFailure || retries >= WS_RECONNECTS) {
          setStatus('failed')
          return
        }
        retries += 1
        setStatus('disconnected')
        timer = setTimeout(connect, Math.min(500 * (2 ** (retries - 1)), 5000))
      }
      socket.onerror = () => { if (!disposed) setStatus('disconnected') }
    }

    const input = terminal.onData(data => {
      if (currentSocket?.readyState === WebSocket.OPEN) currentSocket.send(data)
    })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit)
    observer?.observe(host)
    connect()

    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      input.dispose()
      const active = currentSocket
      if (active?.readyState === WebSocket.OPEN) active.send(JSON.stringify({ type: 'park' }))
      active?.close()
      if (socketRef.current === active) socketRef.current = undefined
      terminal.dispose()
      if (emulatorRef.current === terminal) emulatorRef.current = undefined
    }
  }, [scope.sessionId, tab.id, retryKey])

  useEffect(() => {
    if (visible) emulatorRef.current?.focus()
  }, [visible])

  return h('section', {
    'data-dsh-ws-terminal': '',
    'data-terminal-state': status,
    style: {
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
    },
  },
    h('link', { rel: 'stylesheet', href: hostRouteUrl('sidebar/dsh-ws-terminal/xterm.css').href }),
    status !== 'connected' && status !== 'exited' && h('div', {
      role: 'status',
      style: { padding: '6px 10px', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))' },
    }, status === 'connecting' ? 'Connecting…' : status === 'failed' ? 'Terminal connection failed' : 'Disconnected',
    (status === 'failed' || status === 'disconnected') && h('button', { type: 'button', onClick: retry }, 'Retry')),
    status === 'exited' && h('div', { role: 'status', style: { padding: '6px 10px' } }, 'Process exited.'),
    error && h('div', { role: 'alert', style: { padding: '6px 10px', overflowWrap: 'anywhere' } }, error),
    h('div', {
      ref: hostRef,
      style: {
        flex: '1 1 auto', minWidth: 0, minHeight: 0, padding: 8, overflow: 'hidden',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
        fontFamily: 'var(--ds-font-family-code, monospace)',
      },
    }),
  )
}

function hostRouteUrl(path) {
  const injectedBase = globalThis.__DSH_TRANSPORT__?.streamBaseUrl
  const base = new URL(injectedBase || document.baseURI, document.baseURI)
  base.search = ''
  base.hash = ''
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(path.replace(/^\/+/, ''), base)
}
