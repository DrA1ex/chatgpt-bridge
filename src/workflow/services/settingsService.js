import fs from 'node:fs/promises';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function commitRuntimeMode(mode) {
  if (mode === 'disabled') return 'none';
  return 'block';
}

export class WorkflowSettingsService {
  constructor({ persistRuntime, invalidateNotifications } = {}) {
    this.persistRuntime = persistRuntime;
    this.invalidateNotifications = invalidateNotifications;
  }

  async apply(runtime, defaults = {}) {
    const session = defaults.session || {};
    const notifications = defaults.notifications || {};
    const commits = defaults.commits || {};
    const checks = defaults.checks || {};

    if (defaults.sessionExhaustion) runtime.config.ux.sessionExhaustion = defaults.sessionExhaustion;
    runtime.config.ux.session = {
      ...(runtime.config.ux.session || {}),
      ...(Number.isInteger(session.maxTurns) ? { maxTurns: Math.max(1, session.maxTurns) } : {}),
    };
    if (defaults.invalidResponseAction) {
      runtime.config.ux.invalidResponseAction = defaults.invalidResponseAction;
      runtime.config.resultProtocol.repairAction = defaults.invalidResponseAction;
      runtime.config.remediation.enabled = defaults.invalidResponseAction === 'repair' && runtime.config.preset !== 'apply-changes';
    }
    if (Number.isInteger(defaults.invalidResponseAttempts)) {
      const attempts = Math.max(0, defaults.invalidResponseAttempts);
      runtime.config.ux.invalidResponseAttempts = attempts;
      runtime.config.resultProtocol.repairAttempts = attempts;
      runtime.config.remediation.maxAttempts = attempts;
    }
    runtime.config.ux.notifications = { ...(runtime.config.ux.notifications || {}), ...clone(notifications) };
    runtime.config.ux.checks = { ...(runtime.config.ux.checks || {}), ...clone(checks) };
    if (Number.isInteger(checks.maxAttempts)) runtime.config.automation.maxCycles = Math.max(1, checks.maxAttempts);
    if (Number.isInteger(checks.noProgressLimit)) runtime.config.automation.noProgressLimit = Math.max(1, checks.noProgressLimit);
    if (commits.mode) {
      runtime.config.commit.policy.mode = commits.mode;
      runtime.config.commit.mode = commitRuntimeMode(commits.mode);
      runtime.config.resultProtocol.requireCommitMessage = commits.mode !== 'disabled';
    }
    if (commits.iterationStrategy) runtime.config.commit.policy.iterationStrategy = commits.iterationStrategy;
    if (commits.completionStrategy) runtime.config.commit.policy.completionStrategy = commits.completionStrategy;
    if (typeof commits.includeOnlyWorkflowChanges === 'boolean') {
      runtime.config.commit.policy.includeOnlyWorkflowChanges = commits.includeOnlyWorkflowChanges;
    }

    await this.persist(runtime);
    await this.persistRuntime(runtime);
    this.invalidateNotifications?.();
    return clone(runtime.config);
  }

  async persist(runtime) {
    const { configPath, ...serialized } = runtime.config;
    await fs.writeFile(runtime.configPath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8');
    return serialized;
  }
}
