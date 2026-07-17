import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SESSION_POLICIES = new Set(['start-new-chat', 'ask', 'stop']);
const COMMIT_MODES = new Set(['automatic', 'ask', 'disabled']);
const ITERATION_STRATEGIES = new Set(['checkpoint', 'final-only']);
const COMPLETION_STRATEGIES = new Set(['squash', 'keep-checkpoints']);
const INVALID_RESPONSE_ACTIONS = new Set(['repair', 'ask', 'stop']);

export function defaultGlobalWorkflowConfigPath(dataDir = '') {
  const root = dataDir ? path.resolve(dataDir) : path.join(os.homedir(), '.bridge-data');
  return path.join(root, 'workflows', 'config.json');
}

export function defaultGlobalWorkflowConfig() {
  return {
    version: 1,
    defaults: {
      sessionExhaustion: 'start-new-chat',
      session: {
        maxTurns: 40,
      },
      invalidResponseAction: 'repair',
      invalidResponseAttempts: 2,
      notifications: {
        enabled: true,
        terminalBell: true,
        desktop: true,
        reminderIntervalMs: 15 * 60_000,
      },
      commits: {
        mode: 'automatic',
        iterationStrategy: 'checkpoint',
        completionStrategy: 'squash',
        includeOnlyWorkflowChanges: true,
      },
      checks: {
        maxAttempts: 8,
        noProgressLimit: 3,
      },
    },
    profiles: {},
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function invalid(pathName, expected, value) {
  const rendered = typeof value === 'string' ? JSON.stringify(value) : String(value);
  const error = new Error(`Invalid workflow configuration at ${pathName}: expected ${expected}, got ${rendered}`);
  error.code = 'WORKFLOW_GLOBAL_CONFIG_INVALID';
  error.path = pathName;
  return error;
}

function validateBoolean(value, pathName) {
  if (typeof value !== 'boolean') throw invalid(pathName, 'boolean', value);
}

function validatePositiveInteger(value, pathName, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw invalid(pathName, allowZero ? 'a non-negative integer' : 'a positive integer', value);
  }
}

function validateEnum(value, pathName, values) {
  if (!values.has(value)) throw invalid(pathName, `one of ${Array.from(values).join(', ')}`, value);
}

export function validateGlobalWorkflowConfig(value) {
  if (!isObject(value)) throw invalid('$', 'an object', value);
  if (value.version !== 1) throw invalid('$.version', '1', value.version);
  if (!isObject(value.defaults)) throw invalid('$.defaults', 'an object', value.defaults);
  const defaults = value.defaults;
  validateEnum(defaults.sessionExhaustion, '$.defaults.sessionExhaustion', SESSION_POLICIES);
  if (!isObject(defaults.session)) throw invalid('$.defaults.session', 'an object', defaults.session);
  validatePositiveInteger(defaults.session.maxTurns, '$.defaults.session.maxTurns');
  validateEnum(defaults.invalidResponseAction, '$.defaults.invalidResponseAction', INVALID_RESPONSE_ACTIONS);
  validatePositiveInteger(defaults.invalidResponseAttempts, '$.defaults.invalidResponseAttempts', { allowZero: true });

  if (!isObject(defaults.notifications)) throw invalid('$.defaults.notifications', 'an object', defaults.notifications);
  validateBoolean(defaults.notifications.enabled, '$.defaults.notifications.enabled');
  validateBoolean(defaults.notifications.terminalBell, '$.defaults.notifications.terminalBell');
  validateBoolean(defaults.notifications.desktop, '$.defaults.notifications.desktop');
  validatePositiveInteger(defaults.notifications.reminderIntervalMs, '$.defaults.notifications.reminderIntervalMs', { allowZero: true });

  if (!isObject(defaults.commits)) throw invalid('$.defaults.commits', 'an object', defaults.commits);
  validateEnum(defaults.commits.mode, '$.defaults.commits.mode', COMMIT_MODES);
  validateEnum(defaults.commits.iterationStrategy, '$.defaults.commits.iterationStrategy', ITERATION_STRATEGIES);
  validateEnum(defaults.commits.completionStrategy, '$.defaults.commits.completionStrategy', COMPLETION_STRATEGIES);
  validateBoolean(defaults.commits.includeOnlyWorkflowChanges, '$.defaults.commits.includeOnlyWorkflowChanges');

  if (!isObject(defaults.checks)) throw invalid('$.defaults.checks', 'an object', defaults.checks);
  validatePositiveInteger(defaults.checks.maxAttempts, '$.defaults.checks.maxAttempts');
  validatePositiveInteger(defaults.checks.noProgressLimit, '$.defaults.checks.noProgressLimit');
  if (!isObject(value.profiles)) throw invalid('$.profiles', 'an object', value.profiles);
  for (const [profileName, profile] of Object.entries(value.profiles)) {
    if (!isObject(profile)) throw invalid(`$.profiles.${profileName}`, 'an object', profile);
    if (profile.preset && !['apply-changes', 'fix-until-pass', 'guided-task'].includes(profile.preset)) {
      throw invalid(`$.profiles.${profileName}.preset`, 'apply-changes, fix-until-pass, or guided-task', profile.preset);
    }
    if (profile.project != null && typeof profile.project !== 'string') {
      throw invalid(`$.profiles.${profileName}.project`, 'a string', profile.project);
    }
    if (profile.checks != null && (!Array.isArray(profile.checks) || profile.checks.some((item) => typeof item !== 'string'))) {
      throw invalid(`$.profiles.${profileName}.checks`, 'an array of command strings', profile.checks);
    }
    if (profile.defaults != null) {
      if (!isObject(profile.defaults)) throw invalid(`$.profiles.${profileName}.defaults`, 'an object', profile.defaults);
      const mergedDefaults = mergeObject(defaultGlobalWorkflowConfig().defaults, profile.defaults);
      validateGlobalWorkflowConfig({ version: 1, defaults: mergedDefaults, profiles: {} });
    }
  }
  return clone(value);
}

function mergeObject(base, override) {
  if (!isObject(override)) return clone(base);
  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(result[key])) result[key] = mergeObject(result[key], value);
    else result[key] = clone(value);
  }
  return result;
}

export function mergeGlobalWorkflowConfig(raw = {}) {
  const defaults = defaultGlobalWorkflowConfig();
  const merged = mergeObject(defaults, raw);
  return validateGlobalWorkflowConfig(merged);
}

export async function loadGlobalWorkflowConfig({ dataDir = '', filePath = '', create = false } = {}) {
  const target = path.resolve(filePath || defaultGlobalWorkflowConfigPath(dataDir));
  try {
    const raw = JSON.parse(await fs.readFile(target, 'utf8'));
    return { config: mergeGlobalWorkflowConfig(raw), path: target, exists: true, firstRun: false };
  } catch (error) {
    if (error instanceof SyntaxError) {
      const wrapped = new Error(`Invalid workflow configuration at ${target}: ${error.message}`);
      wrapped.code = 'WORKFLOW_GLOBAL_CONFIG_PARSE_ERROR';
      throw wrapped;
    }
    if (error?.code !== 'ENOENT') throw error;
    const config = defaultGlobalWorkflowConfig();
    if (create) await saveGlobalWorkflowConfig(config, { filePath: target });
    return { config, path: target, exists: false, firstRun: true };
  }
}

export async function saveGlobalWorkflowConfig(config, { dataDir = '', filePath = '' } = {}) {
  const target = path.resolve(filePath || defaultGlobalWorkflowConfigPath(dataDir));
  const validated = validateGlobalWorkflowConfig(mergeGlobalWorkflowConfig(config));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  await fs.rename(temp, target);
  return { config: validated, path: target };
}

export function resolveWorkflowDefaults(globalConfig, profile = {}, overrides = {}) {
  const source = mergeGlobalWorkflowConfig(globalConfig || {});
  return mergeObject(source.defaults, mergeObject(profile.defaults || {}, overrides || {}));
}

export function findWorkflowProfile(globalConfig, { id = '', preset = '', project = '' } = {}) {
  const profiles = isObject(globalConfig?.profiles) ? globalConfig.profiles : {};
  if (id && profiles[id]) return { name: id, profile: clone(profiles[id]) };
  const targetProject = project ? path.resolve(project) : '';
  for (const [name, profile] of Object.entries(profiles)) {
    if (preset && profile?.preset !== preset) continue;
    if (targetProject && (!profile?.project || path.resolve(profile.project) !== targetProject)) continue;
    return { name, profile: clone(profile) };
  }
  return null;
}

export async function updateGlobalWorkflowProfile(name, profile, options = {}) {
  const loaded = await loadGlobalWorkflowConfig({ ...options, create: true });
  const next = clone(loaded.config);
  next.profiles[String(name)] = clone(profile);
  return await saveGlobalWorkflowConfig(next, { ...options, filePath: loaded.path });
}
