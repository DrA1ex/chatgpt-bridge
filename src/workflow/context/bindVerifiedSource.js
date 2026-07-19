import { nowIso } from '../support/workflowValues.js';

export async function bindVerifiedSource({
  runtime,
  response,
  artifact = {},
  persistRuntime,
  transition,
  publish,
  syncRefreshTimer,
  syncProjectContext,
}) {
  if (!runtime.config.watch.bindOnFirstVerifiedArtifact) return false;
  let changed = false;
  const sourceClientId = String(response.sourceClientId || artifact.sourceClientId || '');
  const sessionId = String(response.session?.id || response.sessionId || '');
  if (!runtime.config.watch.clientId && !runtime.boundSourceClientId && sourceClientId) {
    runtime.boundSourceClientId = sourceClientId;
    changed = true;
  }
  if (!runtime.config.watch.sessionId && !runtime.boundSessionId && sessionId) {
    runtime.boundSessionId = sessionId;
    changed = true;
  }
  if (!changed) return false;

  runtime.updatedAt = nowIso();
  const canonicalBinding = runtime.workflowState?.binding || {};
  const canonicalChanged = String(canonicalBinding.clientId || '') !== runtime.boundSourceClientId
    || String(canonicalBinding.sessionId || '') !== runtime.boundSessionId;
  if (typeof transition === 'function' && canonicalChanged) {
    await transition(runtime, 'workflow.binding_changed', {
      clientId: runtime.boundSourceClientId,
      sessionId: runtime.boundSessionId,
      preserveInputs: false,
      reason: 'first-verified-artifact',
    }, 'workflow.binding.changed', {
      sourceClientId: runtime.boundSourceClientId,
      sessionId: runtime.boundSessionId,
      reason: 'first-verified-artifact',
    });
  } else await persistRuntime(runtime);
  await publish(runtime.id, 'workflow.watch.bound', {
    sourceClientId: runtime.boundSourceClientId,
    sessionId: runtime.boundSessionId,
    reason: 'first-verified-artifact',
  });
  syncRefreshTimer(runtime);
  if (runtime.config.projectContext.enabled && runtime.config.projectContext.syncAfterBind) {
    try {
      await syncProjectContext(runtime, { reason: 'first-verified-artifact' });
    } catch (error) {
      await publish(runtime.id, 'workflow.context.sync.failed', {
        reason: 'first-verified-artifact',
        message: error.message || String(error),
      });
    }
  }
  return true;
}
