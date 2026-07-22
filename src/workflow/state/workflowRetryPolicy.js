const RETRY_POLICIES = new Set(['never', 'if_unconfirmed', 'always']);

function count(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function policy(value, fallback = 'never') {
  return RETRY_POLICIES.has(value) ? value : fallback;
}

function writePolicy(value, fallback = 'never') {
  const normalized = policy(value, fallback);
  return normalized === 'always' ? fallback : normalized;
}

export function normalizeWorkflowRetryPolicy(value = {}) {
  return {
    safeLimit: count(value.safeLimit, 3),
    prompt: writePolicy(value.prompt),
    steering: writePolicy(value.steering),
    attachment: writePolicy(value.attachment, 'if_unconfirmed'),
    artifact: writePolicy(value.artifact, 'if_unconfirmed'),
    checks: policy(value.checks, 'always'),
    apply: writePolicy(value.apply),
    rollback: writePolicy(value.rollback, 'if_unconfirmed'),
    commit: writePolicy(value.commit, 'if_unconfirmed'),
    squash: writePolicy(value.squash),
    sessionHandoff: writePolicy(value.sessionHandoff),
    extensionDeploy: writePolicy(value.extensionDeploy),
  };
}

export function workflowEffectRetryMode(state, effectKind) {
  const kind = String(effectKind || '').trim();
  const aliases = {
    prompt: 'prompt', steering: 'steering', attachment: 'attachment', download: 'artifact', verify: 'artifact',
    checks: 'checks', apply: 'apply', rollback: 'rollback', commit: 'commit', squash: 'squash',
    context_sync: 'sessionHandoff', session_handoff: 'sessionHandoff',
  };
  const short = kind.replace(/^.*\./, '');
  const key = aliases[kind] || aliases[short] || short;
  return state?.retryPolicy?.[key] || 'never';
}

export function workflowLocalEffectRetryMode(state, effectKind) {
  const key = String(effectKind || '').trim();
  if (['project_snapshot', 'verify', 'plan'].includes(key)) return 'always';
  if (key === 'checks') return state?.retryPolicy?.checks || 'always';
  if (key === 'apply') return state?.retryPolicy?.apply || 'never';
  if (key === 'squash') return state?.retryPolicy?.squash || 'never';
  if (key === 'commit') return state?.retryPolicy?.commit || 'if_unconfirmed';
  if (key === 'rollback') return state?.retryPolicy?.rollback || 'if_unconfirmed';
  if (key === 'extension_deploy') return state?.retryPolicy?.extensionDeploy || 'never';
  return 'never';
}
