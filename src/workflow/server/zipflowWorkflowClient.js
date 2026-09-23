export const REQUIRED_ZIPFLOW_CAPABILITIES = Object.freeze([
  'projects',
  'workflow_config',
  'blobs',
  'archive_runs',
  'check_runs',
  'semantic_surfaces',
  'actions',
  'plans',
  'diffs',
  'history',
  'rollback',
  'events',
]);

const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'INTERNAL_ERROR',
  'OPERATION_BUSY',
  'CONNECTION_FAILED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
]);
const REDACTED_KEY = /token|authorization|cookie|secret|credential|password/i;

async function defaultSdkLoader() {
  return await import('zipflow/client');
}

function boundedText(value, limit = 800) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function sanitizeDetails(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return boundedText(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDetails(item, depth + 1));
  if (typeof value !== 'object') return boundedText(value, 200);
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    output[key] = REDACTED_KEY.test(key) ? '[redacted]' : sanitizeDetails(item, depth + 1);
  }
  return output;
}

function errorBody(error) {
  return error?.problem && typeof error.problem === 'object'
    ? error.problem
    : error?.body && typeof error.body === 'object'
      ? error.body
      : error?.response?.data && typeof error.response.data === 'object'
        ? error.response.data
        : {};
}

function redactExactSecret(error, secret = '') {
  const value = String(secret || '');
  if (!value || !error) return error;
  const replace = (input) => String(input || '').split(value).join('[redacted]');
  let details = error.details;
  try {
    details = JSON.parse(replace(JSON.stringify(details)));
  } catch {
    details = {};
  }
  return new ZipflowClientError(replace(error.message), {
    code: error.code,
    status: error.status,
    retryable: error.retryable,
    details,
    recoveryAction: error.recoveryAction,
    cause: error,
  });
}

export class ZipflowClientError extends Error {
  constructor(message, {
    code = 'ZIPFLOW_CLIENT_ERROR',
    status = 0,
    retryable = false,
    details = {},
    recoveryAction = '',
    cause = null,
  } = {}) {
    super(boundedText(message) || 'Workflow service request failed', cause ? { cause } : undefined);
    this.name = 'ZipflowClientError';
    this.code = String(code || 'ZIPFLOW_CLIENT_ERROR');
    this.status = Number(status) || 0;
    this.retryable = Boolean(retryable);
    this.details = sanitizeDetails(details);
    this.recoveryAction = boundedText(recoveryAction, 100);
  }
}

export function normalizeZipflowClientError(error) {
  if (error instanceof ZipflowClientError) return error;
  const body = errorBody(error);
  const status = Number(body.status || error?.status || error?.statusCode || error?.response?.status) || 0;
  const code = String(body.code || error?.code || 'ZIPFLOW_CLIENT_ERROR');
  const retryable = body.retryable === true
    || error?.retryable === true
    || RETRYABLE_STATUS.has(status)
    || RETRYABLE_CODES.has(code);
  return new ZipflowClientError(
    body.message || body.title || error?.message || 'Workflow service request failed',
    {
      code,
      status,
      retryable,
      details: body.details || error?.details || {},
      recoveryAction: body.recoveryAction || error?.recoveryAction || '',
      cause: error,
    },
  );
}

function resolveSdkFactory(sdk = {}) {
  if (typeof sdk.createZipflowClient === 'function') return sdk.createZipflowClient;
  if (typeof sdk.createClient === 'function') return sdk.createClient;
  if (typeof sdk.ZipflowClient === 'function') return (options) => new sdk.ZipflowClient(options);
  if (typeof sdk.default === 'function') return sdk.default;
  if (sdk.default && typeof sdk.default.createClient === 'function') return sdk.default.createClient;
  return null;
}

function validateClient(value) {
  if (!value || typeof value !== 'object') {
    throw new ZipflowClientError('zipflow/client did not create a client object', {
      code: 'ZIPFLOW_CLIENT_EXPORT_INVALID',
    });
  }
  return value;
}

function majorVersion(value) {
  const match = /^(\d+)(?:\.|$)/.exec(String(value || '').trim());
  return match ? Number(match[1]) : 0;
}

export function validateZipflowHello(hello, {
  apiMajor = 1,
  minSchemaRevision = 1,
  maxSchemaRevision = 1,
  requiredCapabilities = REQUIRED_ZIPFLOW_CAPABILITIES,
} = {}) {
  if (!hello || typeof hello !== 'object') {
    throw new ZipflowClientError('Workflow service returned an invalid hello response', {
      code: 'API_INCOMPATIBLE',
    });
  }
  if (majorVersion(hello.apiVersion) !== apiMajor) {
    throw new ZipflowClientError(`Unsupported workflow API version: ${hello.apiVersion || '(missing)'}`, {
      code: 'API_INCOMPATIBLE',
      details: { apiVersion: hello.apiVersion || '', supportedMajor: apiMajor },
    });
  }
  const schemaRevision = Number(hello.schemaRevision);
  if (!Number.isInteger(schemaRevision)
    || schemaRevision < minSchemaRevision
    || schemaRevision > maxSchemaRevision) {
    throw new ZipflowClientError(`Unsupported workflow schema revision: ${hello.schemaRevision}`, {
      code: 'API_INCOMPATIBLE',
      details: { schemaRevision, minSchemaRevision, maxSchemaRevision },
    });
  }
  if (!String(hello.serverEpoch || '').trim()) {
    throw new ZipflowClientError('Workflow service hello response has no server epoch', {
      code: 'API_INCOMPATIBLE',
    });
  }
  const capabilities = new Set(Array.isArray(hello.capabilities) ? hello.capabilities.map(String) : []);
  const missing = requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missing.length) {
    throw new ZipflowClientError(`Workflow service is missing required capabilities: ${missing.join(', ')}`, {
      code: 'CAPABILITY_MISSING',
      details: { missing },
    });
  }
  return structuredClone(hello);
}

export class ZipflowWorkflowClient {
  constructor({
    sdkClient = null,
    createSdkClient = null,
    sdkLoader = defaultSdkLoader,
    socketPath = '',
    token = '',
    instanceId = '',
    readRetryLimit = 2,
    retryBaseMs = 100,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    helloPolicy = {},
  } = {}) {
    this.injectedClient = sdkClient;
    this.createSdkClient = createSdkClient;
    this.sdkLoader = sdkLoader;
    this.options = { socketPath, token, client: { name: 'chatgpt-bridge', instanceId } };
    this.readRetryLimit = Math.max(0, Number(readRetryLimit) || 0);
    this.retryBaseMs = Math.max(0, Number(retryBaseMs) || 0);
    this.sleep = sleep;
    this.helloPolicy = helloPolicy;
    this.clientPromise = null;
    this.lastHello = null;
    this.projectIds = new Map();
  }

  async #client() {
    if (!this.clientPromise) {
      this.clientPromise = Promise.resolve().then(async () => {
        if (this.injectedClient) return validateClient(this.injectedClient);
        if (typeof this.createSdkClient === 'function') {
          return validateClient(await this.createSdkClient(this.options));
        }
        const sdk = await this.sdkLoader();
        const factory = resolveSdkFactory(sdk);
        if (!factory) {
          throw new ZipflowClientError('zipflow/client does not export a supported client factory', {
            code: 'ZIPFLOW_CLIENT_EXPORT_INVALID',
          });
        }
        return validateClient(await factory(this.options));
      });
    }
    return await this.clientPromise;
  }

  async #invoke(method, args = [], { mutation = false } = {}) {
    const client = await this.#client();
    if (typeof client[method] !== 'function') {
      throw new ZipflowClientError(`zipflow/client is missing ${method}()`, {
        code: 'ZIPFLOW_CLIENT_METHOD_MISSING',
        details: { method },
      });
    }
    const attempts = mutation ? 1 : this.readRetryLimit + 1;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await client[method](...args);
      } catch (error) {
        lastError = redactExactSecret(normalizeZipflowClientError(error), this.options.token);
        if (mutation || !lastError.retryable || attempt + 1 >= attempts) throw lastError;
        await this.sleep(this.retryBaseMs * (2 ** attempt));
      }
    }
    throw lastError;
  }

  async hello() {
    const hello = validateZipflowHello(await this.#invoke('hello'), this.helloPolicy);
    this.lastHello = hello;
    return structuredClone(hello);
  }

  async openProject(projectPath, { idempotencyKey, instanceId = '' } = {}) {
    const response = await this.#invoke('openProject', [{
      path: String(projectPath || ''),
      client: {
        name: 'chatgpt-bridge',
        instanceId: String(instanceId || this.options.client.instanceId || ''),
      },
      idempotencyKey: String(idempotencyKey || ''),
    }], { mutation: true });
    const projectId = String(response?.projectId || '');
    if (projectId) {
      this.projectIds.set(String(projectPath || ''), projectId);
      if (response?.canonicalPath) this.projectIds.set(String(response.canonicalPath), projectId);
    }
    return response;
  }

  projectIdFor(projectPath) {
    return this.projectIds.get(String(projectPath || '')) || '';
  }

  async getProject(projectId) {
    return await this.#invoke('getProject', [projectId]);
  }

  async getWorkflow(projectId) {
    return await this.#invoke('getWorkflow', [projectId]);
  }

  async putWorkflow(projectId, draft, options = {}) {
    return await this.#invoke('putWorkflow', [projectId, draft, options], { mutation: true });
  }

  async uploadBlob({
    body,
    size,
    filename,
    idempotencyKey,
    signal = undefined,
  } = {}) {
    return await this.#invoke('uploadZip', [body, {
      filename,
      contentLength: size,
      idempotencyKey,
      signal,
    }], { mutation: true });
  }

  async startArchiveRun(projectId, draft, options = {}) {
    return await this.#invoke('startArchiveRun', [projectId, draft, options], { mutation: true });
  }

  async startCheckRun(projectId, draft = {}, options = {}) {
    return await this.#invoke('startCheckRun', [projectId, draft, options], { mutation: true });
  }

  async getRun(runId) {
    return await this.#invoke('getRun', [runId]);
  }

  async getOperation(operationId) {
    return await this.#invoke('getOperation', [operationId]);
  }

  async getSurface(runId) {
    return await this.#invoke('getSurface', [runId]);
  }

  async getPlan(runId, query = {}) {
    return await this.#invoke('getPlan', [runId, query]);
  }

  async getDiff(runId, query = {}) {
    return await this.#invoke('getDiff', [runId, query]);
  }

  async getOutput(runId, query = {}) {
    return await this.#invoke('getOutput', [runId, query]);
  }

  async getReport(runId, options = {}) {
    return await this.#invoke('getReport', [runId, options]);
  }

  async getHistory(projectId, query = {}) {
    return await this.#invoke('getHistory', [projectId, query]);
  }

  async performAction(runId, actionId, input = {}, options = {}) {
    return await this.#invoke('performAction', [runId, actionId, input, options], { mutation: true });
  }

  async cancelOperation(operationId, options = {}) {
    return await this.#invoke('cancelOperation', [operationId, options], { mutation: true });
  }

  async subscribeEvents(options = {}) {
    return await this.#invoke('subscribeEvents', [options]);
  }

  async close() {
    const client = await this.#client().catch(() => null);
    await client?.close?.();
  }
}
