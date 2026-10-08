import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { TerminalRegistry } from '../terminal-registry.js'

class FakeHandle {
  constructor() {
    this.output = new PassThrough()
    this.writes = []
    this.resizes = []
    this.terminated = 0
    this.done = new Promise(resolve => { this.finish = resolve })
  }
  write(data) { this.writes.push(data); return Promise.resolve() }
  resize(cols, rows) { this.resizes.push([cols, rows]); return Promise.resolve() }
  async terminate() { this.terminated++; this.finish({ exitCode: 0, signal: null }); this.output.end() }
}

class FakeSocket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  sent = []
  send(data, options) { this.sent.push({ data, options }) }
  close(_code, reason) { this.readyState = 3; this.reason = reason; this.emit('close') }
}

function harness(maxPerSession = 8) {
  const handles = []
  const subprocess = {
    terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/sh' }),
    resolveExecutable: async command => command,
    spawnTerminal: async spec => {
      const handle = new FakeHandle()
      handle.spec = spec
      handles.push(handle)
      return handle
    },
  }
  const sessions = { get: id => id === 's1' ? { header: { cwd: '/workspace' } } : undefined }
  return { registry: new TerminalRegistry({ subprocess, sessions, maxPerSession, reconnectGraceMs: 10_000 }), handles, subprocess }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('each unique sidebar tab gets an independent PTY identity', async () => {
  const { registry, handles } = harness()
  const first = new FakeSocket()
  const second = new FakeSocket()
  await registry.attach(first, 's1', 'tab-a', 80, 24)
  await registry.attach(second, 's1', 'tab-b', 100, 30)
  assert.equal(handles.length, 2)
  assert.deepEqual(handles.map(handle => [handle.spec.cols, handle.spec.rows]), [[80, 24], [100, 30]])

  first.emit('message', Buffer.from('echo first'))
  second.emit('message', Buffer.from('echo second'))
  await tick()
  assert.deepEqual(handles.map(handle => handle.writes[0]), ['echo first', 'echo second'])

  handles[0].output.write(Buffer.from('first output'))
  await tick()
  assert.equal(first.sent.some(frame => Buffer.from(frame.data).toString().includes('first output')), true)
  assert.equal(second.sent.some(frame => Buffer.from(frame.data).toString().includes('first output')), false)
  await registry.dispose()
  assert.deepEqual(handles.map(handle => handle.terminated), [1, 1])
})

test('a reconnect adopts the same PTY and receives its bounded transcript', async () => {
  const { registry, handles } = harness()
  const first = new FakeSocket()
  await registry.attach(first, 's1', 'tab-a', 80, 24)
  handles[0].output.write(Buffer.from('restored output'))
  await tick()
  first.close(1000, 'transport-drop')

  const reconnected = new FakeSocket()
  await registry.attach(reconnected, 's1', 'tab-a', 80, 24)
  assert.equal(handles.length, 1)
  assert.equal(reconnected.sent.some(frame => Buffer.from(frame.data).toString().includes('restored output')), true)
  await registry.dispose()
})

test('a session terminal cap is enforced', async () => {
  const { registry } = harness(1)
  await registry.attach(new FakeSocket(), 's1', 'tab-a', 80, 24)
  await assert.rejects(() => registry.attach(new FakeSocket(), 's1', 'tab-b', 80, 24), /terminal limit reached/)
  await registry.dispose()
})

test('concurrent opens count pending allocations against the session cap', async () => {
  const { registry, handles, subprocess } = harness(1)
  let releaseEnvironment
  subprocess.terminalEnvironment = () => new Promise(resolve => { releaseEnvironment = () => resolve({ platform: 'posix', defaultShell: '/bin/sh' }) })
  const firstOpen = registry.attach(new FakeSocket(), 's1', 'tab-a', 80, 24)
  await tick()
  await assert.rejects(() => registry.attach(new FakeSocket(), 's1', 'tab-b', 80, 24), /terminal limit reached/)
  releaseEnvironment()
  await firstOpen
  assert.equal(handles.length, 1)
  await registry.dispose()
})

test('unknown sessions cannot allocate a PTY', async () => {
  const { registry, handles } = harness()
  await assert.rejects(() => registry.attach(new FakeSocket(), 'not-a-session', 'tab-a'), /working directory is unavailable/)
  assert.equal(handles.length, 0)
  await registry.dispose()
})
