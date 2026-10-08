import test from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedUpgrade } from '../trust-fence.js'

const request = (host, origin, extra = {}) => ({ headers: { host, ...(origin === undefined ? {} : { origin }), ...extra } })

test('accepts same-origin loopback browser upgrades', () => {
  assert.equal(isTrustedUpgrade(request('127.0.0.1:10167', 'http://127.0.0.1:10167')), true)
})

test('rejects cross-site browser upgrades even to loopback', () => {
  assert.equal(isTrustedUpgrade(request('127.0.0.1:10167', 'https://attacker.example', { 'sec-fetch-site': 'cross-site' })), false)
})

test('requires explicit trust for non-loopback Host authorities', () => {
  assert.equal(isTrustedUpgrade(request('192.168.1.4:10167', 'http://192.168.1.4:10167')), false)
  assert.equal(isTrustedUpgrade(request('192.168.1.4:10167', 'http://192.168.1.4:10167'), ['192.168.1.4']), true)
})
