import { nowIso } from '../support/workflowValues.js';
import { workflowBinding } from '../support/workflowBinding.js';

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
  const current = workflowBinding(runtime);
  const observedClientId = String(response.sourceClientId || artifact.sourceClientId || '');
  const observedSessionId = String(response.session?.id || response.sessionId || '');
  const nextClientId = current.clientId || observedClientId;
  const nextSessionId = current.sessionId || observedSessionId;
  if (nextClientId === current.clientId && nextSessionId === current.sessionId) return false;

  runtime.updatedAt = nowIso();
  if (typeof transition === 'function') {
    await transition(runtime, 'workflow.binding_changed', {
      clientId: nextClientId,
      sessionId: nextSessionId,
      preserveInputs: false,
      reason: 'first-verified-artifact',
    }, 'workflow.binding.changed', {
      sourceClientId: nextClientId,
      sessionId: nextSessionId,
      reason: 'first-verified-artifact',
    });
  } else {
    throw new Error('Verified workflow source binding requires a canonical state transition');
  }
  await publish(runtime.id, 'workflow.watch.bound', {
    sourceClientId: nextClientId,
    sessionId: nextSessionId,
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
