import {
  RequestBlocker,
  RequestDeadlineKind,
  RequestEffectType,
  RequestEventType,
  RequestTerminalCode,
  SourceConnection,
  SubmissionState,
} from './requestEvents.js';
import { appendDiagnostics, terminalResult, transitionTime } from './requestTransitions.js';
import { effectDomain, effectSlot, withEffectSlot } from './requestMachineSupport.js';

const EFFECT_EVENTS = new Set([
  RequestEventType.EFFECT_STARTED,
  RequestEventType.EFFECT_SUCCEEDED,
  RequestEventType.EFFECT_CANCELLED,
  RequestEventType.EFFECT_FAILED,
  RequestEventType.EFFECT_UNCERTAIN,
  RequestEventType.EFFECT_RECONCILED,
]);

export function reduceRequestEffectTransition(state, event) {
  if (!EFFECT_EVENTS.has(event.type)) return null;
  const data = event.data || {};
  const at = transitionTime(event);
  switch (event.type) {
    case RequestEventType.EFFECT_STARTED: {
      const domain = effectDomain(data);
      const slot = effectSlot(state, domain);
      if (slot.activeId && slot.activeId !== data.effectId) {
        return terminalResult(
          state,
          RequestTerminalCode.INVALID_TRANSITION,
          `${domain} effect ${data.effectId || data.effectType || 'unknown'} started while ${slot.activeId} is still active`,
          data,
          event,
        );
      }
      return {
        state: withEffectSlot(state, domain, {
          activeId: String(data.effectId || ''),
          activeType: String(data.effectType || ''),
          startedAt: at,
          lastResult: null,
        }),
        effects: [], deadlines: [], diagnostics: [],
      };
    }
    case RequestEventType.EFFECT_SUCCEEDED:
    case RequestEventType.EFFECT_CANCELLED: {
      const domain = effectDomain(data);
      const slot = effectSlot(state, domain);
      const duplicate = String(slot.lastResult?.data?.effectId || '') === String(data.effectId || '')
        && slot.lastResult?.type === event.type;
      if (duplicate) {
        const diagnostics = [{ code: 'duplicate_effect_result', message: `Ignored duplicate ${domain} effect result for ${data.effectId || data.effectType || 'effect'}` }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      const mismatched = slot.activeId && data.effectId && slot.activeId !== data.effectId;
      const diagnostics = mismatched ? [{
        code: 'stale_effect_result',
        message: `Ignored result for stale ${domain} effect ${data.effectId}; active effect is ${slot.activeId}`,
      }] : [];
      if (mismatched) return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      const nextState = withEffectSlot(state, domain, {
        activeId: null,
        activeType: null,
        lastResult: { type: event.type, at, data },
      });
      if (domain === 'browser' && String(data.effectType || '') === 'prompt.cancel') {
        if (event.type === RequestEventType.EFFECT_SUCCEEDED) {
          return terminalResult(
            nextState,
            RequestTerminalCode.CANCELLED,
            String(data.message || 'Browser generation was cancelled'),
            { ...data, cancelEffectId: data.effectId || '' },
            event,
          );
        }
        return terminalResult(
          nextState,
          RequestTerminalCode.EFFECT_FAILED,
          String(data.message || 'Browser cancellation was proved not to have executed'),
          { ...data, recoverable: true },
          event,
        );
      }
      const preparationKinds = new Set(['page.ready.initial', 'session.apply', 'model.apply', 'attachments.upload']);
      const continueExecution = event.type === RequestEventType.EFFECT_SUCCEEDED
        && domain === 'browser'
        && state.submission !== SubmissionState.SUBMITTED
        && preparationKinds.has(String(data.effectType || ''));
      return {
        state: nextState,
        effects: continueExecution ? [{
          id: `prompt-execution-next:${state.requestId}:${data.effectId || event.eventId}`,
          type: RequestEffectType.PROMPT_EXECUTION_STEP,
          data: {
            requestId: state.requestId,
            originalEffectId: String(data.effectId || ''),
            effectType: String(data.effectType || ''),
            resumeMode: 'continue_after',
            reason: 'effect_succeeded',
          },
        }] : [],
        deadlines: [], diagnostics: [],
      };
    }
    case RequestEventType.EFFECT_FAILED: {
      const domain = effectDomain(data);
      const next = withEffectSlot(state, domain, {
        activeId: null,
        activeType: null,
        lastResult: { type: event.type, at, data },
      });
      if (data.retryable === true) {
        const diagnostics = [{ code: 'retryable_effect_failure', message: String(data.message || 'Retryable effect failure'), data }];
        return { state: appendDiagnostics(next, diagnostics), effects: [], deadlines: [], diagnostics };
      }
      return terminalResult(next, RequestTerminalCode.EFFECT_FAILED, String(data.message || 'Request effect failed'), data, event);
    }
    case RequestEventType.EFFECT_UNCERTAIN: {
      const domain = effectDomain(data);
      if (domain !== 'browser') {
        const diagnostics = [{ code: 'invalid_uncertain_effect_domain', message: 'Only physical browser effects may become uncertain' }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      const slot = effectSlot(state, 'browser');
      const previousUncertain = slot.lastResult?.type === RequestEventType.EFFECT_UNCERTAIN
        && String(slot.lastResult?.data?.effectId || '') === String(data.effectId || '')
        && state.source?.connection === SourceConnection.RECONCILING;
      if (previousUncertain) {
        const diagnostics = [{ code: 'duplicate_effect_uncertain', message: `Ignored duplicate uncertain result for ${data.effectId || data.effectType || 'browser effect'}` }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      const mismatched = slot.activeId && data.effectId && slot.activeId !== data.effectId;
      if (mismatched) {
        const diagnostics = [{
          code: 'stale_effect_result',
          message: `Ignored uncertain result for stale browser effect ${data.effectId}; active effect is ${slot.activeId}`,
        }];
        return { state: appendDiagnostics(state, diagnostics), effects: [], deadlines: [], diagnostics, accepted: false };
      }
      const deadlineAt = at + Math.max(5_000, Number(data.recoveryTimeoutMs) || 30_000);
      const uncertainState = withEffectSlot(state, 'browser', {
        activeId: null,
        activeType: null,
        lastResult: { type: event.type, at, data },
      });
      return {
        state: appendDiagnostics({
          ...uncertainState,
          source: { ...uncertainState.source, connection: SourceConnection.RECONCILING },
          blocker: RequestBlocker.RECOVERY,
        }, [{
          code: 'browser_effect_uncertain',
          message: String(data.message || 'Browser effect result is uncertain after reload'),
          data,
        }]),
        effects: [{
          id: `effect-reconcile:${state.requestId}:${data.effectId || event.eventId}`,
          type: RequestEffectType.EFFECT_RECONCILE,
          data: {
            requestId: state.requestId,
            effectId: data.effectId || '',
            effectType: data.effectType || '',
            idempotencyKey: data.idempotencyKey || '',
            retryPolicy: data.retryPolicy || 'if_unconfirmed',
            preconditions: data.preconditions || {},
            preconditionsHash: data.preconditionsHash || '',
            attempt: Math.max(1, Number(data.attempt) || 1),
            evidence: data.evidence || null,
          },
        }],
        deadlines: [{
          id: `recovery:${state.requestId}:${deadlineAt}`,
          kind: RequestDeadlineKind.RECOVERY,
          type: RequestDeadlineKind.RECOVERY,
          dueAt: deadlineAt,
          message: 'Browser effect could not be reconciled after content reload',
        }],
        diagnostics: [],
      };
    }
    case RequestEventType.EFFECT_RECONCILED: {
      const outcome = String(data.outcome || 'uncertain');
      if (outcome === 'succeeded') {
        if (String(data.effectType || '') === 'prompt.cancel') {
          const reconciledState = withEffectSlot(state, 'browser', {
            activeId: null,
            activeType: null,
            lastResult: { type: event.type, at, data },
          });
          return terminalResult(
            reconciledState,
            RequestTerminalCode.CANCELLED,
            String(data.message || 'Browser cancellation was proved after reconciliation'),
            { ...data, cancelEffectId: data.originalEffectId || data.effectId || '' },
            event,
          );
        }
        const resumablePreparationEffects = new Set([
          'page.ready.initial',
          'session.apply',
          'model.apply',
          'attachments.upload',
        ]);
        const resumePreparation = state.submission !== SubmissionState.SUBMITTED
          && resumablePreparationEffects.has(String(data.effectType || ''));
        const reconciledState = withEffectSlot(state, 'browser', {
          activeId: null,
          activeType: null,
          lastResult: { type: event.type, at, data },
        });
        return {
          state: appendDiagnostics({
            ...reconciledState,
            source: { ...reconciledState.source, connection: SourceConnection.CONNECTED },
            blocker: RequestBlocker.NONE,
          }, [{ code: 'browser_effect_reconciled', message: String(data.message || 'Browser effect outcome was proved after reload'), data }]),
          effects: resumePreparation ? [{
            id: `prompt-execution-resume:${state.requestId}:${data.originalEffectId || event.eventId}`,
            type: RequestEffectType.PROMPT_EXECUTION_STEP,
            data: {
              requestId: state.requestId,
              originalEffectId: String(data.originalEffectId || data.effectId || ''),
              effectType: String(data.effectType || ''),
              resumeMode: 'continue_after',
            },
          }] : [],
          deadlines: [], diagnostics: [],
        };
      }
      if (outcome === 'not_started') {
        const retryable = String(data.retryPolicy || 'if_unconfirmed') !== 'never';
        if (!retryable) {
          return terminalResult(
            state,
            RequestTerminalCode.RECOVERY_UNCERTAIN,
            String(data.message || 'Browser effect was proved not to have started but its retry policy forbids automatic retry'),
            { ...data, recoverable: true, safeToRetryAsNewRequest: true },
            event,
          );
        }
        const reconciledState = withEffectSlot(state, 'browser', {
          activeId: null,
          activeType: null,
          lastResult: { type: event.type, at, data },
        });
        const cancelRetry = String(data.effectType || '') === 'prompt.cancel';
        return {
          state: appendDiagnostics({
            ...reconciledState,
            source: { ...reconciledState.source, connection: SourceConnection.CONNECTED },
            blocker: RequestBlocker.NONE,
          }, [{ code: 'browser_effect_proved_not_started', message: String(data.message || 'Browser effect was proved not to have started and will be retried with the same logical identity'), data }]),
          effects: [{
            id: `${cancelRetry ? 'prompt-cancel' : 'prompt-execution'}-retry:${state.requestId}:${data.originalEffectId || data.effectId || event.eventId}`,
            type: cancelRetry ? RequestEffectType.PROMPT_CANCEL_RETRY : RequestEffectType.PROMPT_EXECUTION_STEP,
            data: {
              requestId: state.requestId,
              originalEffectId: String(data.originalEffectId || data.effectId || ''),
              effectType: String(data.effectType || ''),
              idempotencyKey: String(data.idempotencyKey || ''),
              retryPolicy: String(data.retryPolicy || 'if_unconfirmed'),
              preconditions: data.preconditions || {},
              attempt: Math.max(1, Number(data.attempt) || 1),
              resumeMode: 'retry_same',
            },
          }],
          deadlines: [],
          diagnostics: [],
        };
      }
      if (outcome === 'failed') {
        return terminalResult(
          state,
          RequestTerminalCode.EFFECT_FAILED,
          String(data.message || 'Browser effect was proved to have failed'),
          { ...data, recoverable: Boolean(data.recoverable) },
          event,
        );
      }
      return {
        state: appendDiagnostics(state, [{
          code: 'browser_effect_reconcile_inconclusive',
          message: String(data.message || 'Browser effect reconciliation remained inconclusive'),
          data,
        }]),
        effects: [], deadlines: [], diagnostics: [],
      };
    }
    default:
      return null;
  }
}
