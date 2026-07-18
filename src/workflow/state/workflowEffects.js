import {
  WorkflowActionKind,
  WorkflowEffectKind,
  WorkflowEffectStatus,
  WorkflowEventType,
  workflowEffectRetryMode,
} from './workflowState.js';

const SAFE_EFFECTS = new Set([
  WorkflowEffectKind.CONTEXT_SYNC,
  WorkflowEffectKind.CHECKS,
  WorkflowEffectKind.DOWNLOAD,
  WorkflowEffectKind.VERIFY,
  WorkflowEffectKind.PLAN,
]);

export function isSafeWorkflowEffect(kind) {
  return SAFE_EFFECTS.has(String(kind || ''));
}

export function unresolvedWorkflowEffects(state = {}) {
  return Object.values(state.effects || {}).filter((effect) => effect && ![
    WorkflowEffectStatus.SUCCEEDED,
    WorkflowEffectStatus.FAILED,
    WorkflowEffectStatus.CANCELLED,
  ].includes(effect.status));
}

export function recoveryDecisionForWorkflow(state = {}) {
  const unresolved = unresolvedWorkflowEffects(state);
  const blocked = unresolved.filter((effect) => {
    if (effect.status === WorkflowEffectStatus.PLANNED) return false;
    if (effect.safe) return effect.attempt >= Number(state.retryPolicy?.safeLimit || 0);
    const policy = workflowEffectRetryMode(state, effect.kind);
    if (policy === 'always') return false;
    if (policy === 'if_unconfirmed') return [WorkflowEffectStatus.DISPATCHED, WorkflowEffectStatus.UNCERTAIN].includes(effect.status);
    return true;
  });
  if (!blocked.length) return { automatic: true, effectIds: unresolved.map((effect) => effect.id) };
  const effect = blocked[0];
  const policy = workflowEffectRetryMode(state, effect.kind);
  return {
    automatic: false,
    action: {
      kind: WorkflowActionKind.RECOVERY,
      reason: `Cannot safely determine whether ${effect.kind} (${effect.id}) completed before restart.`,
      choices: [
        { id: 'retry', label: 'Retry with the same operation key', transition: 'recover' },
        { id: 'stop', label: 'Stop without repeating the write', transition: 'stop' },
      ],
      references: { effectId: effect.id, effectKind: effect.kind, status: effect.status },
    },
  };
}

/**
 * Small reducer-facing executor wrapper. It commits the intent before calling
 * the side effect and converts every result to a typed state event.
 */
export async function executeWorkflowEffect({ transition, runtime, effect, execute, afterDispatch = null }) {
  if (typeof transition !== 'function' || typeof execute !== 'function') throw new TypeError('Workflow effect execution requires transition and execute');
  const effectId = String(effect?.id || '');
  const kind = String(effect?.kind || '');
  if (!effectId || !Object.values(WorkflowEffectKind).includes(kind)) throw new TypeError('Workflow effect requires a known id and kind');
  const existing = runtime.workflowState.effects?.[effectId];
  if (existing?.status === WorkflowEffectStatus.SUCCEEDED) return existing.result;
  if (existing && existing.status !== WorkflowEffectStatus.PLANNED) throw Object.assign(new Error(`Effect ${effectId} must be recovered before dispatch; current status is ${existing.status}`), { code: 'WORKFLOW_EFFECT_NOT_RECOVERED' });
  if (!existing) {
    await transition(runtime, WorkflowEventType.EFFECT_PLANNED, {
      effectId,
      runId: runtime.workflowState.run.id,
      kind,
      safe: effect.safe ?? isSafeWorkflowEffect(kind),
      idempotencyKey: effect.idempotencyKey || effectId,
      preconditionsHash: effect.preconditionsHash,
      references: effect.references || {},
    });
  } else if (existing.idempotencyKey !== (effect.idempotencyKey || effectId) || existing.preconditionsHash !== effect.preconditionsHash) {
    throw Object.assign(new Error(`Effect ${effectId} recovery guards changed`), { code: 'WORKFLOW_EFFECT_GUARD_MISMATCH' });
  }
  await transition(runtime, WorkflowEventType.EFFECT_DISPATCHED, { effectId });
  const attempt = runtime.workflowState.effects[effectId].attempt;
  try {
    if (typeof afterDispatch === 'function') await afterDispatch({ effectId, attempt });
    const result = await execute();
    await transition(runtime, WorkflowEventType.EFFECT_SUCCEEDED, { effectId, attempt, result: result || {} });
    return result;
  } catch (error) {
    const uncertain = Boolean(error?.uncertain || error?.code === 'EFFECT_OUTCOME_UNKNOWN');
    await transition(runtime, uncertain ? WorkflowEventType.EFFECT_UNCERTAIN : WorkflowEventType.EFFECT_FAILED, {
      effectId,
      attempt,
      error: error?.message || String(error),
    });
    throw error;
  }
}
