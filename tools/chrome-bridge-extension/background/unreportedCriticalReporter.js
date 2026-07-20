import { MessageKind } from './protocolV4.js';

function requestIdentity(record = {}) {
  return {
    requestId: String(record.requestId || ''),
    leaseId: String(record.leaseId || ''),
    ownerServerInstanceId: String(record.ownerServerInstanceId || ''),
    responseEpoch: Math.max(0, Number(record.responseEpoch) || 0),
  };
}

function commandPayload(command) {
  if (command.resultPayload && typeof command.resultPayload === 'object') {
    return {
      ...command.resultPayload,
      type: ['rejected', 'uncertain'].includes(command.status) ? 'command.error' : 'command.result',
      commandId: command.commandId,
      requestId: command.requestId,
      recoveredFromDurableState: true,
    };
  }
  const rejected = ['rejected', 'uncertain'].includes(command.status);
  return rejected ? {
    type: 'command.error',
    commandId: command.commandId,
    requestId: command.requestId,
    code: String(command.error?.code || (command.status === 'uncertain' ? 'COMMAND_OUTCOME_UNCERTAIN' : 'COMMAND_REJECTED')),
    message: String(command.error?.message || command.error || 'Browser command failed'),
    uncertain: command.status === 'uncertain',
  } : {
    type: 'command.result',
    commandId: command.commandId,
    requestId: command.requestId,
    resultType: String(command.resultType || 'command.completed'),
    recoveredFromDurableState: true,
  };
}

function effectPayload(effect) {
  const failed = effect.status !== 'succeeded';
  return {
    type: `request.effect.${effect.status}`,
    requestId: effect.requestId,
    effectId: effect.effectId,
    effectType: effect.kind,
    idempotencyKey: effect.idempotencyKey,
    retryPolicy: effect.retryPolicy,
    preconditions: effect.preconditions || {},
    preconditionsHash: effect.preconditionsHash || '',
    responseEpoch: effect.responseEpoch || 0,
    attempt: effect.attempt || 1,
    commandId: effect.commandId || '',
    causationId: effect.causationId || '',
    result: effect.result || null,
    reconciliationEvidence: effect.reconciliationEvidence || null,
    cancellationEvidence: effect.cancellationEvidence || null,
    provenNotExecuted: effect.status === 'cancelled',
    ...(failed ? {
      code: String(effect.error?.code || (effect.status === 'uncertain' ? 'BROWSER_EFFECT_UNCERTAIN' : effect.status === 'cancelled' ? 'BROWSER_EFFECT_CANCELLED' : 'BROWSER_EFFECT_FAILED')),
      message: String(effect.error?.message || effect.error || `Browser effect ${effect.status}`),
      recoverable: effect.status === 'uncertain',
    } : {}),
  };
}

export function createUnreportedCriticalReporter({ backgroundState, sendProtocolPayload } = {}) {
  const running = new Map();

  async function markCommandReported(state, command) {
    const result = await backgroundState.transition(state.tabId, {
      type: 'command.reported',
      commandId: command.commandId,
      ...(command.scope === 'request' ? requestIdentity(command) : {}),
      contentEpoch: state.contentEpoch,
    });
    if (!result.accepted && !['command_already_reported', 'command_missing'].includes(result.reason)) {
      throw new Error(`Unable to mark recovered command report: ${result.reason}`);
    }
  }

  async function markEffectReported(state, effect) {
    const result = await backgroundState.transition(state.tabId, {
      type: 'effect.reported',
      effectId: effect.effectId,
      ...requestIdentity(effect),
      contentEpoch: state.contentEpoch,
    });
    if (!result.accepted && !['effect_already_reported', 'effect_missing'].includes(result.reason)) {
      throw new Error(`Unable to mark recovered effect report: ${result.reason}`);
    }
  }

  async function flushNow(state) {
    if (!state || state.ws?.readyState !== 1) return { flushed: 0, reason: 'transport_unavailable' };
    let flushed = 0;
    for (;;) {
      const runtime = await backgroundState.read(state.tabId);
      const persistedCommandIds = new Set(runtime.outbox.map((item) => String(item.commandId || '')).filter(Boolean));
      const persistedEffectIds = new Set(runtime.outbox.map((item) => String(item.effectId || '')).filter(Boolean));
      let progressed = false;
      for (const command of (runtime.commandOrder || []).map((id) => runtime.commands?.[id]).filter(Boolean)) {
        if (command.reportedAt || !['succeeded', 'rejected', 'uncertain'].includes(command.status)) continue;
        if (persistedCommandIds.has(command.commandId)) {
          await markCommandReported(state, command);
          progressed = true;
          continue;
        }
        try {
          await sendProtocolPayload(state, commandPayload(command), {
            kind: command.status === 'succeeded' ? MessageKind.COMMAND_RESULT : MessageKind.COMMAND_REJECTED,
            lease: command.scope === 'request' ? requestIdentity(command) : null,
            critical: true,
          });
        } catch (error) {
          if (/outbox_(?:full|reserved_capacity)|critical_outbox_full/i.test(String(error?.message || ''))) return { flushed, reason: 'outbox_full' };
          throw error;
        }
        await markCommandReported(state, command);
        flushed += 1;
        progressed = true;
      }
      for (const effect of (runtime.effectOrder || []).map((id) => runtime.effects?.[id]).filter(Boolean)) {
        if (effect.reportedAt || !['succeeded', 'failed', 'uncertain', 'cancelled'].includes(effect.status)) continue;
        if (persistedEffectIds.has(effect.effectId)) {
          await markEffectReported(state, effect);
          progressed = true;
          continue;
        }
        try {
          await sendProtocolPayload(state, effectPayload(effect), {
            kind: effect.status === 'uncertain' ? MessageKind.EFFECT_UNCERTAIN : MessageKind.EFFECT_RESULT,
            lease: requestIdentity(effect),
            critical: true,
          });
        } catch (error) {
          if (/outbox_(?:full|reserved_capacity)|critical_outbox_full/i.test(String(error?.message || ''))) return { flushed, reason: 'outbox_full' };
          throw error;
        }
        await markEffectReported(state, effect);
        flushed += 1;
        progressed = true;
      }
      if (!progressed) return { flushed, reason: 'complete' };
    }
  }

  function flush(state) {
    const key = Number(state?.tabId);
    if (!Number.isInteger(key)) return Promise.resolve({ flushed: 0, reason: 'tab_missing' });
    const existing = running.get(key);
    if (existing) return existing;
    const task = flushNow(state).finally(() => {
      if (running.get(key) === task) running.delete(key);
    });
    running.set(key, task);
    return task;
  }

  return Object.freeze({ flush });
}
