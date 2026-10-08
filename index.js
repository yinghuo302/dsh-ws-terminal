import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { WebSocket, WebSocketServer } from 'ws'
import { TerminalRegistry } from './terminal-registry.js'
import { isTrustedUpgrade } from './trust-fence.js'

const require = createRequire(import.meta.url)
const terminalCss = readFileSync(require.resolve('@xterm/xterm/css/xterm.css'))
const WS_PATH = '/sidebar/ws/dsh-ws-terminal'
const CSS_PATH = '/sidebar/dsh-ws-terminal/xterm.css'

export const inject = ['webServer', 'subprocess', 'sessions', 'webRuntime']

/** Host half: own a bounded set of session/tab-scoped PTYs and WS transports. */
export function apply(ctx) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  const registry = new TerminalRegistry({ subprocess: ctx.subprocess, sessions: ctx.sessions })
  ctx.effect(() => {
    const unregisterWs = ctx.webServer.registerUpgrade({
      path: WS_PATH,
      handler: (request, socket, head) => {
        if (!isTrustedUpgrade(request, ctx.webRuntime?.trustedHosts ?? [])) {
          socket.destroy()
          return
        }
        sockets.handleUpgrade(request, socket, head, ws => {
          const url = new URL(request.url ?? '/', 'http://dsh.internal')
          const sessionId = url.searchParams.get('sessionId')
          const tabId = url.searchParams.get('tab')
          const cols = positiveDimension(url.searchParams.get('cols'), 80)
          const rows = positiveDimension(url.searchParams.get('rows'), 24)
          void registry.attach(ws, sessionId, tabId, cols, rows).catch(error => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
              ws.close(1011, 'terminal-open-failed')
            }
          })
        })
      },
    })
    const unregisterCss = ctx.webServer.register({
      kind: 'exact',
      path: CSS_PATH,
      handler: (_request, response) => {
        response.writeHead(200, {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        })
        response.end(terminalCss)
      },
    })
    return async () => {
      unregisterCss()
      unregisterWs()
      await registry.dispose()
      sockets.close()
    }
  }, 'dsh-ws-terminal: routes and PTY registry')
}

function positiveDimension(value, fallback) {
  if (value === null || value.length > 6) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 2 && parsed <= 1024 ? parsed : fallback
}
