/**
 * Same-origin request fence for the terminal WebSocket route. It permits
 * loopback and explicitly trusted authorities, rejects cross-site requests,
 * and checks browser Origin against the Host authority. This is a
 * DNS-rebinding/CSRF boundary, not authentication.
 */
const SHELL_APP_ORIGIN = 'dsh-app://app'

export function isTrustedUpgrade(request, trustedHosts = []) {
  const headers = request?.headers ?? {}
  const host = one(headers.host)
  if (host === undefined) return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  if (!isLoopback(hostUrl.hostname) && !trustedAuthority(hostUrl, trustedHosts)) return false

  if (one(headers['sec-fetch-site']) === 'cross-site') return false
  const origin = one(headers.origin)
  if (origin === undefined || origin === SHELL_APP_ORIGIN) return true
  try { return new URL(origin).hostname === hostUrl.hostname } catch { return false }
}

function one(value) {
  return typeof value === 'string' ? value : undefined
}

function isLoopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function trustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some(entry => {
    let entryUrl
    try { entryUrl = new URL(`http://${entry}`) } catch { return false }
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}
