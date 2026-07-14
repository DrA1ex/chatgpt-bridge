import fs from 'node:fs/promises';
import path from 'node:path';
import { requestTraceFromDiagnostics } from '../../src/bridge/replay/requestTrace.js';

function safeName(value) {
  return String(value || 'request').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

export async function writeFailedRequestStateTrace(reportDir, requestId, diagnostics, reason = '') {
  if (!reportDir || !diagnostics?.state) return '';
  const directory = path.join(reportDir, 'request-state');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${safeName(requestId)}.json`);
  const trace = requestTraceFromDiagnostics(diagnostics, { requestId, reason });
  await fs.writeFile(filePath, `${JSON.stringify(trace, null, 2)}\n`);
  return filePath;
}
