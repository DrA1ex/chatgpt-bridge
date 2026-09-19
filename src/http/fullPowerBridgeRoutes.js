import { config } from '../config.js';
import { HttpError } from '../httpError.js';
import { forwardFullPowerRequest, fullPowerBridgeEnabled } from '../fullPowerBridgeClient.js';
import { secureTokenEqual } from '../security/token.js';

function requireStrictApiToken(req, _res, next) {
  // Full-Power credentials must never be accepted from a URL query string;
  // URLs are routinely copied into browser history, proxy logs and referrers.
  const auth = String(req.headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer || String(req.headers['x-bridge-token'] || '');
  if (!secureTokenEqual(supplied, config.apiToken)) {
    next(new HttpError(401, 'Unauthorized: Full-Power Bridge requires the configured API_TOKEN'));
    return;
  }
  next();
}

function requireFullPowerOwnerToken(req, _res, next) {
  const expected = String(config.fullPowerOwnerToken || '').trim();
  const supplied = String(req.headers['x-full-power-owner-token'] || '').trim();
  if (!secureTokenEqual(supplied, expected)) {
    next(new HttpError(401, 'Owner confirmation requires the configured Full-Power owner token'));
    return;
  }
  next();
}

export function registerFullPowerBridgeRoutes(router) {
  router.get('/v1/full-power/health', requireStrictApiToken, async (_req, res, next) => {
    try {
      res.json({ ok: true, enabled: fullPowerBridgeEnabled(), ...(await forwardFullPowerRequest('/health')) });
    } catch (error) { next(error); }
  });

  router.post('/v1/full-power/capabilities', requireStrictApiToken, async (req, res, next) => {
    try {
      res.status(201).json(await forwardFullPowerRequest('/v1/manager/capabilities', { method: 'POST', body: req.body || {} }));
    } catch (error) { next(error); }
  });

  router.post('/v1/full-power/jobs', requireStrictApiToken, async (req, res, next) => {
    try {
      res.status(201).json(await forwardFullPowerRequest('/v1/manager/jobs', { method: 'POST', body: req.body || {} }));
    } catch (error) { next(error); }
  });

  router.get('/v1/full-power/jobs', requireStrictApiToken, async (_req, res, next) => {
    try { res.json(await forwardFullPowerRequest('/v1/manager/jobs')); }
    catch (error) { next(error); }
  });

  router.get('/v1/full-power/jobs/:jobId', requireStrictApiToken, async (req, res, next) => {
    try { res.json(await forwardFullPowerRequest(`/v1/manager/jobs/${encodeURIComponent(req.params.jobId)}`)); }
    catch (error) { next(error); }
  });

  router.get('/v1/full-power/owner/jobs/:jobId/result', requireStrictApiToken, requireFullPowerOwnerToken, async (req, res, next) => {
    try {
      res.json(await forwardFullPowerRequest(`/v1/owner/jobs/${encodeURIComponent(req.params.jobId)}/result`, {
        method: 'GET',
        authToken: config.fullPowerOwnerToken,
      }));
    } catch (error) { next(error); }
  });

  router.post('/v1/full-power/owner/jobs/:jobId/:action', requireStrictApiToken, requireFullPowerOwnerToken, async (req, res, next) => {
    try {
      const action = String(req.params.action || '').trim().toLowerCase();
      if (!['challenge', 'confirm', 'cancel'].includes(action)) throw new HttpError(400, 'Unknown Full-Power owner operation');
      res.json(await forwardFullPowerRequest(`/v1/owner/jobs/${encodeURIComponent(req.params.jobId)}/${action}`, {
        method: 'POST',
        body: req.body || {},
        authToken: config.fullPowerOwnerToken,
      }));
    } catch (error) { next(error); }
  });
}
