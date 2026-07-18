export function createScenarioInfrastructureGate() {
  let rootFailure = null;

  function recordRecovery(scenarioId, recovery = {}) {
    if (recovery.recovered || rootFailure) return rootFailure;
    rootFailure = Object.freeze({
      scenarioId: String(scenarioId || 'unknown'),
      message: String(recovery.error || recovery.reason || 'owned browser client did not recover'),
    });
    return rootFailure;
  }

  function blockedScenario(scenarioId) {
    if (!rootFailure) return null;
    return Object.freeze({
      id: String(scenarioId || 'unknown'),
      blockedBy: rootFailure.scenarioId,
      reason: rootFailure.message,
    });
  }

  return Object.freeze({
    blockedScenario,
    current: () => rootFailure,
    recordRecovery,
  });
}
