function text(value) {
  return String(value ?? '').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return '';
}

function eventIdentity(event = {}) {
  return firstNonEmpty(
    event.name,
    event.data?.name,
    event.payload?.name,
    event.type,
    event.eventType,
    event.data?.type,
    event.payload?.type,
    'runtime',
  );
}

function eventMessage(event = {}) {
  return firstNonEmpty(
    event.message,
    event.reason,
    event.error,
    event.data?.message,
    event.data?.reason,
    event.data?.error,
    event.payload?.message,
    event.payload?.reason,
    event.payload?.error,
  );
}

function isRuntimeErrorEvent(event = {}) {
  const identity = eventIdentity(event).toLowerCase();
  const message = eventMessage(event);
  return /(?:^|[._-])(error|failed|failure)(?:$|[._-])/.test(identity)
    || /(?:ReferenceError|TypeError|SyntaxError|\bis not defined\b)/i.test(message);
}

function pushIssue(issues, seen, issue = {}) {
  const severity = issue.severity === 'ERROR' ? 'ERROR' : 'FAILED';
  const scope = firstNonEmpty(issue.scope, 'e2e');
  const message = firstNonEmpty(issue.message, 'Unknown failure');
  const key = `${severity}\u0000${scope}\u0000${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  issues.push({ severity, scope, message });
}

export function collectE2eIssues({ report = {}, scenarioFailures = [], primaryError = null } = {}) {
  const issues = [];
  const seen = new Set();

  for (const failure of scenarioFailures || []) {
    pushIssue(issues, seen, {
      severity: 'FAILED',
      scope: failure.id || failure.name || 'scenario',
      message: failure.error?.message || failure.message,
    });
  }

  for (const scenario of report.scenarios || []) {
    if (!['failed', 'interrupted'].includes(scenario?.status)) continue;
    const interrupted = scenario.status === 'interrupted';
    pushIssue(issues, seen, {
      severity: 'FAILED',
      scope: scenario.id || scenario.name || 'scenario',
      message: interrupted
        ? (scenario.note || `Scenario was interrupted${report.interruption?.signal ? ` by ${report.interruption.signal}` : ''}`)
        : (scenario.error?.message || 'Scenario failed'),
    });
  }

  if (report.cleanup?.failed) {
    pushIssue(issues, seen, {
      severity: 'FAILED',
      scope: 'cleanup',
      message: report.cleanup.error,
    });
  }

  if (report.diagnosticsCollectionError) {
    pushIssue(issues, seen, {
      severity: 'ERROR',
      scope: 'diagnostics.collection',
      message: report.diagnosticsCollectionError,
    });
  }

  if (report.diagnosticsWriteError) {
    pushIssue(issues, seen, {
      severity: 'ERROR',
      scope: 'diagnostics.write',
      message: report.diagnosticsWriteError,
    });
  }

  if (report.downloadCleanupVerificationError) {
    pushIssue(issues, seen, {
      severity: 'FAILED',
      scope: 'download-cleanup-verification',
      message: report.downloadCleanupVerificationError,
    });
  }

  for (const event of [...(report.bridgeEvents || []), ...(report.debugEvents || [])]) {
    if (!isRuntimeErrorEvent(event)) continue;
    const message = eventMessage(event);
    if (!message) continue;
    const clientId = firstNonEmpty(event.clientId, event.data?.clientId, event.payload?.clientId);
    const identity = eventIdentity(event);
    pushIssue(issues, seen, {
      severity: 'ERROR',
      scope: clientId ? `${identity}:${clientId}` : identity,
      message,
    });
  }

  const primaryMessage = primaryError?.message || report.error?.message;
  if (primaryMessage && !issues.some((issue) => issue.message === primaryMessage)) {
    pushIssue(issues, seen, {
      severity: 'FAILED',
      scope: primaryError?.name || 'e2e',
      message: primaryMessage,
    });
  }

  return issues;
}

export function formatE2eIssueSummary(issues = []) {
  if (!issues.length) return '';
  return [
    '',
    '=== E2E FAILURE SUMMARY ===',
    ...issues.map((issue) => `${issue.severity} [${issue.scope}] ${issue.message}`),
    '=== END E2E FAILURE SUMMARY ===',
  ].join('\n');
}


export function writeE2eIssueSummary(issues, { writeLine = null } = {}) {
  const output = formatE2eIssueSummary(issues);
  if (!output) return false;
  console.error(output);
  if (typeof writeLine === 'function') writeLine(output);
  return true;
}
