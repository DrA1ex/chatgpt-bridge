import { initSse, writeNamedSse } from './eventStreams.js';

function writeObservedTurn(res, envelope) {
  res.write(`id: ${envelope.sequence}\n`);
  writeNamedSse(res, 'observed_turn', envelope);
}

export function streamObservedTurns(req, res, bridge) {
  initSse(res);
  let closed = false;
  let lastSequence = Math.max(
    0,
    Number(req.query.after || 0) || 0,
    Number(req.headers['last-event-id'] || 0) || 0,
  );

  const write = (envelope) => {
    if (closed || !envelope || envelope.sequence <= lastSequence) return;
    lastSequence = envelope.sequence;
    writeObservedTurn(res, envelope);
  };

  const unsubscribe = bridge.onObservedTurnEnvelope((envelope) => write(envelope));
  writeNamedSse(res, 'ready', {
    listening: true,
    afterSequence: lastSequence,
    at: new Date().toISOString(),
  });
  for (const envelope of bridge.listObservedTurns({ afterSequence: lastSequence, limit: Number(req.query.limit) || 200 })) write(envelope);

  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 15_000);
  keepalive.unref?.();

  res.on('close', () => {
    closed = true;
    clearInterval(keepalive);
    unsubscribe?.();
  });
}
