import { initSse, writeNamedSse } from './eventStreams.js';

function writeObservedTurn(res, envelope) {
  res.write(`id: ${envelope.streamEpoch}:${envelope.sequence}\n`);
  writeNamedSse(res, 'observed_turn', envelope);
}

function requestedCursor(req) {
  const rawId = String(req.headers['last-event-id'] || '');
  const match = rawId.match(/^([^:]+):(\d+)$/);
  return {
    streamEpoch: String(req.query.epoch || req.headers['last-event-epoch'] || match?.[1] || ''),
    afterSequence: Math.max(0, Number(req.query.after || match?.[2] || rawId || 0) || 0),
  };
}

export function streamObservedTurns(req, res, bridge) {
  initSse(res);
  let closed = false;
  const cursor = requestedCursor(req);
  const state = bridge.observedTurnStreamState(cursor);
  if (state.status === 'gap') {
    writeNamedSse(res, 'stream.gap', state);
    res.end();
    return;
  }
  let lastSequence = state.afterSequence;
  if (state.status === 'reset') {
    lastSequence = 0;
    writeNamedSse(res, 'stream.reset', state);
  }

  const write = (envelope) => {
    if (closed || !envelope || envelope.streamEpoch !== state.streamEpoch || envelope.sequence <= lastSequence) return;
    lastSequence = envelope.sequence;
    writeObservedTurn(res, envelope);
  };

  const unsubscribe = bridge.onObservedTurnEnvelope((envelope) => write(envelope));
  writeNamedSse(res, 'ready', {
    listening: true,
    serverInstanceId: state.serverInstanceId || '',
    streamEpoch: state.streamEpoch,
    afterSequence: lastSequence,
    retainedFromSequence: state.retainedFromSequence,
    latestSequence: state.latestSequence,
    reset: state.status === 'reset',
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
