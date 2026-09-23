export const WORKFLOW_SERVER_STATE_SCHEMA_VERSION = 4;
export const WORKFLOW_SERVER_BACKEND = 'zipflow-server-v1';

const LOCAL_WORKFLOW_STRING_FIELDS = Object.freeze([
  'projectId',
  'runId',
  'operationId',
  'seriesId',
  'blobId',
  'archiveSha256',
  'serverEpoch',
]);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function stateError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function emptyLocalWorkflowState() {
  return {
    backend: WORKFLOW_SERVER_BACKEND,
    projectId: '',
    runId: '',
    operationId: '',
    seriesId: '',
    blobId: '',
    archiveSha256: '',
    serverEpoch: '',
    eventCursor: 0,
    lastSurfaceRevision: 0,
  };
}

export function normalizeLocalWorkflowState(value = {}) {
  const source = record(value);
  const backend = text(source.backend) || WORKFLOW_SERVER_BACKEND;
  if (backend !== WORKFLOW_SERVER_BACKEND) {
    throw stateError(
      'WORKFLOW_SERVER_BACKEND_UNSUPPORTED',
      `Unsupported workflow backend: ${backend}`,
    );
  }

  const normalized = emptyLocalWorkflowState();
  normalized.backend = backend;
  for (const field of LOCAL_WORKFLOW_STRING_FIELDS) normalized[field] = text(source[field]);
  normalized.eventCursor = nonNegativeInteger(source.eventCursor);
  normalized.lastSurfaceRevision = nonNegativeInteger(source.lastSurfaceRevision);
  return normalized;
}

export function normalizeWorkflowServerState(value = {}) {
  const source = record(value);
  const version = source.schemaVersion == null
    ? WORKFLOW_SERVER_STATE_SCHEMA_VERSION
    : Number(source.schemaVersion);
  if (version !== WORKFLOW_SERVER_STATE_SCHEMA_VERSION) {
    throw stateError(
      'WORKFLOW_SERVER_STATE_INCOMPATIBLE',
      `Workflow server state must use schema v${WORKFLOW_SERVER_STATE_SCHEMA_VERSION}`,
    );
  }

  return {
    schemaVersion: WORKFLOW_SERVER_STATE_SCHEMA_VERSION,
    localWorkflow: normalizeLocalWorkflowState(source.localWorkflow),
  };
}

export function patchWorkflowServerState(current = {}, patch = {}) {
  const state = normalizeWorkflowServerState(current);
  const source = record(patch);
  const localPatch = source.localWorkflow ? record(source.localWorkflow) : source;
  return normalizeWorkflowServerState({
    schemaVersion: WORKFLOW_SERVER_STATE_SCHEMA_VERSION,
    localWorkflow: {
      ...state.localWorkflow,
      ...localPatch,
    },
  });
}

export function workflowServerStateEquals(left, right) {
  return JSON.stringify(normalizeWorkflowServerState(left))
    === JSON.stringify(normalizeWorkflowServerState(right));
}
