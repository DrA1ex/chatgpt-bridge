import { config } from '../config.js';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const OUTCOME_HTTP_STATUS = Object.freeze({
  confirmed: 200,
  ambiguous: 202,
  rejected: 409,
});

function localPeerAllowed(req) {
  return LOOPBACK_PEERS.has(String(req.socket?.remoteAddress || ''));
}

export function registerLocalReleaseRoutes(router, bridge) {
  router.post('/__local/release-stale-request', async (req, res) => {
    if (!config.apiToken) {
      res.status(401).json({ detail: 'API_TOKEN must be configured for local stale request lease recovery' });
      return;
    }

    if (!localPeerAllowed(req)) {
      res.status(403).json({ detail: 'Local stale request lease recovery only accepts loopback connections' });
      return;
    }

    try {
      const outcome = await bridge.releaseStaleRequestLease(req.body);
      const status = String(outcome?.status || '');
      const httpStatus = OUTCOME_HTTP_STATUS[status];
      if (!httpStatus) {
        res.status(500).json({ status: 'error' });
        return;
      }
      res.status(httpStatus).json({ status });
    } catch {
      res.status(500).json({ status: 'error' });
    }
  });
}
