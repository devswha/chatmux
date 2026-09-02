// The address a rate limiter should count for a request.
//
// `app.set('trust proxy', 1)` is needed so cookies get the Secure flag behind
// Tailscale Serve or nginx, but it makes req.ip follow X-Forwarded-For for any
// immediate peer, including a LAN client that connects directly and can put
// whatever it likes in that header. A reverse proxy on this host connects from
// loopback, so forwarded headers are honoured only then; every other peer is
// counted by its socket address, which it cannot forge.

/** @param {unknown} address */
export function normalizePeerAddress(address) {
  if (typeof address !== 'string' || !address) return 'unknown-peer';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1']);

/** @param {{ ip?: unknown, socket?: { remoteAddress?: unknown } }} req */
export function limiterClientAddress(req) {
  const peer = normalizePeerAddress(req.socket?.remoteAddress);
  if (LOOPBACK_PEERS.has(peer) && typeof req.ip === 'string' && req.ip) return normalizePeerAddress(req.ip);
  return peer;
}
