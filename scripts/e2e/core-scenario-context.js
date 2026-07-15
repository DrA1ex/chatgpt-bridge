export const CORE_SCENARIO_REQUIRED_FUNCTIONS = Object.freeze([
  'scenario',
  'effortFor',
  'assert',
  'testLog',
  'step',
  'logEvent',
  'api',
  'nowIso',
  'sha256',
  'normalizeAnswer',
  'sendSynchronousMessage',
  'createThread',
  'startTurn',
  'waitTurn',
  'turnEvents',
  'eventTypes',
  'eventData',
  'scenarioDiagnosticDir',
  'createParserObservationWriter',
  'firstDifference',
  'mergeObservedProgress',
  'progressRevisionTimeline',
  'reasoningTestPrompt',
  'extractReasoningProgressPercentages',
  'validateReasoningFinalAnswer',
  'readIntelligenceSnapshot',
  'intelligenceSnapshotFromApplied',
  'explicitSelectionCases',
  'alternativeSelectionOption',
  'optionLabel',
  'selectionOptionMatches',
  'waitForSteerWindow',
  'artifactsFromResponse',
  'artifactsFromTurn',
  'selectArtifactCandidate',
  'downloadArtifact',
  'inspectZipBuffer',
]);

export const CORE_SCENARIO_REQUIRED_VALUES = Object.freeze([
  'options',
  'marker',
  'workDir',
  'runId',
  'effortState',
  'FAST_EFFORT',
  'DEFAULT_REASONING_EFFORT',
  'REASONING_PROGRESS_PERCENTAGES',
  'fs',
  'path',
]);

function dependencyError(kind, names) {
  return new TypeError(`Core E2E context is missing ${kind}: ${names.join(', ')}`);
}

export function createCoreScenarioContextFactory(staticContext = {}) {
  const missingFunctions = CORE_SCENARIO_REQUIRED_FUNCTIONS.filter((name) => typeof staticContext[name] !== 'function');
  if (missingFunctions.length) throw dependencyError('function dependencies', missingFunctions);

  const missingValues = CORE_SCENARIO_REQUIRED_VALUES.filter((name) => staticContext[name] === undefined || staticContext[name] === null);
  if (missingValues.length) throw dependencyError('value dependencies', missingValues);

  const base = Object.freeze({ ...staticContext });

  return function buildCoreScenarioContext(dynamicContext = {}) {
    const sessionId = String(dynamicContext.sessionId || '').trim();
    const sessionUrl = String(dynamicContext.sessionUrl || '').trim();
    const testClient = dynamicContext.testClient;
    const missingDynamic = [];
    if (!sessionId) missingDynamic.push('sessionId');
    if (!sessionUrl) missingDynamic.push('sessionUrl');
    if (!testClient?.id) missingDynamic.push('testClient.id');
    if (missingDynamic.length) throw dependencyError('runtime values', missingDynamic);

    return {
      ...base,
      sessionId,
      sessionUrl,
      testClient,
    };
  };
}
