import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { apply } from '../index.js'

const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition was not reached before timeout')
}

test('registered Host WebSocket route opens a PTY and carries terminal traffic', async t => {
  let upgradeHandler
  let cleanup
  let resolveDone
  const writes = []
  const resizes = []
  const output = new PassThrough()
  let terminalSpec
  const subprocess = {
    terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/sh' }),
    resolveExecutable: async command => command,
    spawnTerminal: async spec => {
      terminalSpec = spec
      return {
        output,
        done: new Promise(resolve => { resolveDone = resolve }),
        write: async data => { writes.push(data) },
        resize: async (cols, rows) => { resizes.push([cols, rows]) },
        terminate: async () => {
          output.end()
          resolveDone({ exitCode: 0 })
        },
      }
    },
  }
  const ctx = {
    webServer: {
      registerUpgrade: route => { upgradeHandler = route.handler; return () => {} },
      register: () => () => {},
    },
    subprocess,
    sessions: { get: id => id === 'session-1' ? { header: { cwd: '/workspace' } } : undefined },
    webRuntime: { trustedHosts: [] },
    effect: setup => { cleanup = setup() },
  }
  apply(ctx)

  const server = createServer()
  server.on('upgrade', (request, socket, head) => upgradeHandler(request, socket, head))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    await cleanup?.()
    await new Promise(resolve => server.close(resolve))
  })

  const address = server.address()
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/sidebar/ws/dsh-ws-terminal?sessionId=session-1&tab=tab-a&cols=90&rows=28`)
  t.after(() => { if (client.readyState === WebSocket.OPEN) client.close() })
  await new Promise((resolve, reject) => {
    client.once('open', resolve)
    client.once('error', reject)
  })
  await waitFor(() => terminalSpec !== undefined)
  assert.deepEqual(terminalSpec, {
    argv: ['/bin/sh', '-l'],
    cwd: '/workspace',
    cols: 90,
    rows: 28,
    terminalType: 'xterm-256color',
    graceMs: 30_000,
  })

  client.send('hello from xterm')
  await waitFor(() => writes.includes('hello from xterm'))
  client.send(JSON.stringify({ type: 'resize', cols: 100, rows: 32 }))
  await waitFor(() => resizes.some(([cols, rows]) => cols === 100 && rows === 32))

  const outputFrame = new Promise(resolve => client.once('message', data => resolve(Buffer.from(data).toString('utf8'))))
  output.write('pty output')
  assert.equal(await outputFrame, 'pty output')
})
