import { HttpError } from '../httpError.js';

export function initSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

export function writeNamedSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function streamEventBus(req, res, eventBus, channel) {
  if (!eventBus) {
    res.status(503).json({ detail: 'Event bus is not configured' });
    return;
  }

  initSse(res);
  const limit = Number.parseInt(String(req.query.limit || '50'), 10);
  const includeRecent = req.query.recent !== '0';
  const eventName = channel === 'debug' ? 'debug' : 'event';
  let closed = false;

  const write = (event) => {
    if (!closed) writeNamedSse(res, eventName, event);
  };

  if (includeRecent) {
    const recent = channel === 'debug'
      ? eventBus.recentDebugEvents(Number.isFinite(limit) ? limit : 50)
      : eventBus.recentEvents(Number.isFinite(limit) ? limit : 50);
    for (const event of recent) write(event);
  }

  const handler = (event) => write(event);
  eventBus.on(eventName, handler);

  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15_000);
  keepalive.unref?.();

  res.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    eventBus.off(eventName, handler);
  });
}

export function streamJobEvents(req, res, jobManager, jobId) {
  if (!jobManager) throw new HttpError(503, 'Job manager is not configured');
  initSse(res);
  const includeRecent = req.query.recent !== '0';
  const limit = Number.parseInt(String(req.query.limit || '500'), 10);
  let closed = false;

  const write = (event) => {
    if (!closed) writeNamedSse(res, 'event', event);
  };

  Promise.resolve()
    .then(async () => {
      if (includeRecent) {
        const events = await jobManager.getJobEvents(jobId, {
          limit: Number.isFinite(limit) ? limit : 500,
        });
        for (const event of events) write(event);
      }
      const job = await jobManager.getJob(jobId);
      if (job && ['done', 'failed', 'cancelled'].includes(job.status)) {
        writeNamedSse(res, 'done', { job });
        res.end();
      }
    })
    .catch((err) => {
      if (!closed) writeNamedSse(res, 'error', {
        error: err.message || 'Failed to stream job events',
      });
    });

  const handler = (event) => {
    write(event);
    if (['job.done', 'job.failed', 'job.cancelled'].includes(event.type)) {
      writeNamedSse(res, 'done', { event });
      res.end();
    }
  };
  jobManager.on(`job:${jobId}`, handler);

  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15_000);
  keepalive.unref?.();

  res.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    jobManager.off(`job:${jobId}`, handler);
  });
}

export function streamTurnEvents(req, res, turnManager, turnId) {
  if (!turnManager) throw new HttpError(503, 'Turn manager is not configured');
  initSse(res);
  const includeRecent = req.query.recent !== '0';
  const limit = Number.parseInt(String(req.query.limit || '1000'), 10);
  let closed = false;
  const write = (event) => {
    if (!closed) writeNamedSse(res, 'event', event);
  };

  Promise.resolve()
    .then(async () => {
      if (includeRecent) {
        const events = await turnManager.getTurnEvents(turnId, {
          limit: Number.isFinite(limit) ? limit : 1000,
        });
        for (const event of events) write(event);
      }
      const turn = await turnManager.getTurn(turnId);
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

  const handler = (event) => {
    write(event);
    if (['turn/completed', 'turn/completed_without_artifact', 'turn/failed', 'turn/interrupted', 'turn/cancelled'].includes(event.type)) {
      writeNamedSse(res, 'done', { event });
      res.end();
    }
  };
  turnManager.on(`turn:${turnId}`, handler);

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
