import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../index.js'

test('Host declares the runtime trust service and registers its routes', async () => {
  assert.deepEqual(inject, ['webServer', 'subprocess', 'sessions', 'webRuntime'])
  const registrations = []
  const disposals = []
  const webServer = {
    registerUpgrade: route => { registrations.push(['upgrade', route.path]); return () => disposals.push(route.path) },
    register: route => { registrations.push(['http', route.path]); return () => disposals.push(route.path) },
  }
  let effectCleanup
  const ctx = {
    webServer,
    subprocess: {},
    sessions: {},
    webRuntime: { trustedHosts: [] },
    effect: setup => { effectCleanup = setup() },
  }
  apply(ctx)
  assert.deepEqual(registrations, [
    ['upgrade', '/sidebar/ws/dsh-ws-terminal'],
    ['http', '/sidebar/dsh-ws-terminal/xterm.css'],
  ])
  await effectCleanup()
  assert.deepEqual(disposals, ['/sidebar/dsh-ws-terminal/xterm.css', '/sidebar/ws/dsh-ws-terminal'])
})

test('compiled Client module registers a fresh Better Sidebar tab per open', async () => {
  const originalWindow = globalThis.window
  let bundle
  globalThis.window = { __ModuleLoader__: { load: value => { bundle = value } } }
  try {
    await import(`../lib/client.js?test=${Date.now()}`)
    assert.equal(bundle.id, '@local/dsh-ws-terminal')
    const client = bundle.factory(id => {
      if (id === 'react') return { createElement() {}, useCallback() {}, useEffect() {}, useLayoutEffect() {}, useRef() {}, useState() {} }
      throw new Error(`unexpected module external: ${id}`)
    })
    const descriptors = []
    let cleanup
    client.apply({
      effect: setup => { cleanup = setup() },
      betterSidebar: { registerTab: descriptor => { descriptors.push(descriptor); return () => {} } },
    })
    assert.equal(descriptors.length, 1)
    assert.equal(descriptors[0].id, 'dsh-ws-terminal:terminal')
    assert.equal(descriptors[0].createTab().tab.id.startsWith('ws-terminal:'), true)
    assert.notEqual(descriptors[0].createTab().tab.id, descriptors[0].createTab().tab.id)
    cleanup()
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
