import { HttpError } from '../httpError.js';
import { initSse, writeNamedSse } from './eventStreams.js';

const TERMINAL_EVENT_TYPES = new Set([
  'turn/completed',
  'turn/completed_without_artifact',
  'turn/failed',
  'turn/interrupted',
  'turn/cancelled',
]);

function boolQuery(value) {
  return value === '1' || value === 'true';
}

export function streamTurnEvents(req, res, turnManager, turnId, options = {}) {
  if (!turnManager) throw new HttpError(503, 'Turn manager is not configured');
  initSse(res);
  const includeRecent = req.query.recent !== '0';
  const allowMissing = options.allowMissing === true || boolQuery(req.query.wait);
  const limit = Number.parseInt(String(req.query.limit || '1000'), 10);
  let closed = false;
  const write = (event) => {
    if (!closed) writeNamedSse(res, 'event', event);
  };

  const handler = (event) => {
    write(event);
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      writeNamedSse(res, 'done', { event });
      res.end();
    }
  };
  turnManager.on(`turn:${turnId}`, handler);

  writeNamedSse(res, 'ready', {
    turnId,
    listening: true,
    includeRecent,
    allowMissing,
    at: new Date().toISOString(),
  });

  Promise.resolve()
    .then(async () => {
      if (includeRecent) {
        const events = await turnManager.getTurnEvents(turnId, {
          limit: Number.isFinite(limit) ? limit : 1000,
        });
        for (const event of events) write(event);
      }
      const turn = await turnManager.getTurn(turnId);
      if (!turn && !allowMissing) {
        writeNamedSse(res, 'error', { error: `Turn not found: ${turnId}` });
        res.end();
        return;
      }
      if (turn && ['completed', 'completed_without_artifact', 'failed', 'interrupted', 'cancelled'].includes(turn.status)) {
        writeNamedSse(res, 'done', { turn });
        res.end();
      }
    })
    .catch((err) => {
      if (!closed) writeNamedSse(res, 'error', {
        error: err.message || 'Failed to stream turn events',
      });
    });

  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15_000);
  keepalive.unref?.();

  res.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    turnManager.off(`turn:${turnId}`, handler);
  });
}
