import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { requestTraceFromDiagnostics } from '../../src/bridge/replay/requestTrace.js';

const FIXTURE_SCHEMA_VERSION = 1;
const MAX_SNAPSHOTS_PER_REQUEST = 64;
const SENSITIVE_ATTRIBUTE = /^(?:nonce|integrity|data-token|data-auth|data-user-id|data-account-id)$/i;
const IDENTITY_ATTRIBUTE = /^(?:data-message-id|data-turn-id|data-turn-id-container)$/i;
const URL_ATTRIBUTE = /^(?:href|src|action|poster)$/i;

function safeName(value = 'fixture') {
  return String(value || 'fixture').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'fixture';
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function replaceDynamicValues(value, replacements = []) {
  let output = String(value ?? '');
  for (const [from, to] of replacements) {
    if (!from) continue;
    output = output.split(String(from)).join(String(to));
  }
  return output;
}

function sanitizeUrl(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  if (/^data:/i.test(raw)) return 'data:application/octet-stream;base64,REDACTED';
  if (/^blob:/i.test(raw)) return 'blob:https://chatgpt.com/captured-fixture';
  try {
    const parsed = new URL(raw, 'https://chatgpt.com/');
    const basename = parsed.pathname.split('/').filter(Boolean).pop() || 'resource';
    return `${parsed.protocol === 'http:' ? 'http:' : 'https:'}//example.invalid/${encodeURIComponent(basename)}`;
  } catch {
    return raw.replace(/[?#].*$/, '');
  }
}

function sanitizeHtml(html = '', replacements = []) {
  let output = replaceDynamicValues(html, replacements)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, 'captured@example.invalid')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer REDACTED')
    .replace(/\b(?:sk|sess|token)[-_][A-Za-z0-9_-]{12,}\b/gi, 'REDACTED_TOKEN');
  output = output.replace(/\s([:\w-]+)=("[^"]*"|'[^']*')/g, (match, rawName, quotedValue) => {
    const name = String(rawName || '');
    const quote = quotedValue[0];
    const value = quotedValue.slice(1, -1);
    if (SENSITIVE_ATTRIBUTE.test(name)) return '';
    if (IDENTITY_ATTRIBUTE.test(name)) return ` ${name}=${quote}captured-${safeName(name)}${quote}`;
    if (URL_ATTRIBUTE.test(name)) return ` ${name}=${quote}${sanitizeUrl(value)}${quote}`;
    return ` ${name}=${quote}${value}${quote}`;
  });
  return output.trim();
}

function sanitizeValue(value, replacements = [], depth = 0) {
  if (depth > 10) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeValue(item, replacements, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return replaceDynamicValues(value, replacements)
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, 'captured@example.invalid')
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer REDACTED');
  }
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:sourceHtml|domHtml)$/i.test(key)) continue;
    if (/(?:token|secret|authorization|cookie|attachmentBody)$/i.test(key)) output[key] = '[redacted]';
    else output[key] = sanitizeValue(item, replacements, depth + 1);
  }
  return output;
}

function eventData(event = {}) {
  return event?.data && typeof event.data === 'object' ? event.data : event;
}

function normalizedExpected(snapshot = {}, replacements = []) {
  const audit = snapshot.parserAudit && typeof snapshot.parserAudit === 'object' ? snapshot.parserAudit : {};
  return sanitizeValue({
    phase: snapshot.phase || snapshot.domPhase || '',
    answer: snapshot.answer || '',
    thinking: snapshot.thinking || '',
    progress: snapshot.progress || '',
    progressItems: snapshot.progressItems || [],
    visibleBlocks: snapshot.visibleBlocks || [],
    responseBlocks: snapshot.responseBlocks || [],
    codeBlocks: snapshot.codeBlocks || [],
    codeBlockDiagnostics: snapshot.codeBlockDiagnostics || [],
    format: snapshot.format || '',
    artifacts: snapshot.artifacts || [],
    parserAudit: {
      version: audit.version || 0,
      coverage: audit.coverage || null,
      warnings: audit.warnings || [],
      unknownItems: audit.unknownItems || [],
      duplicateItems: audit.duplicateItems || [],
      interfaceItems: audit.interfaceItems || [],
      artifactItems: audit.artifactItems || [],
    },
  }, replacements);
}

function snapshotsFromTurn(snapshot = {}, events = []) {
  const snapshots = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'assistant.dom.snapshot') continue;
    snapshots.push({
      at: event.time || event.createdAt || event.at || '',
      eventId: event.id || event.sequence || '',
      data: eventData(event),
    });
  }
  const agent = (snapshot.items || []).find((item) => item.type === 'agent_message');
  const terminal = agent?.content && typeof agent.content === 'object' ? agent.content : null;
  if (terminal?.parserAudit?.sourceHtml) snapshots.push({ at: '', eventId: 'terminal-item', data: terminal, terminal: true });
  return snapshots;
}

export function withDomCaptureMetadata(body = {}, enabled = false) {
  if (!enabled) return body;
  return {
    ...body,
    metadata: {
      ...(body.metadata || {}),
      captureDomTimeline: true,
    },
    captureDomTimeline: true,
  };
}

export function createDomFixtureCapture({ enabled = false, outputDir = '', runId = '', marker = '', log = () => {} } = {}) {
  const replacements = [
    [marker, 'BRIDGE_E2E_CAPTURED_MARKER'],
    [String(runId || '').toUpperCase(), 'CAPTURED_RUN_ID'],
    [runId, 'CAPTURED_RUN_ID'],
  ].filter(([from]) => from).sort((left, right) => String(right[0]).length - String(left[0]).length);
  const index = [];

  async function capture({ scope = 'scenario', requestId = '', turnSnapshot = null, response = null, events = [], canonical = null } = {}) {
    if (!enabled || !outputDir) return [];
    const sourceSnapshot = turnSnapshot || { items: [{ type: 'agent_message', content: response || {} }] };
    const candidates = snapshotsFromTurn(sourceSnapshot, events);
    if (response?.parserAudit?.sourceHtml) candidates.push({ at: '', eventId: 'sync-response', data: response, terminal: true });
    const seen = new Set();
    const selected = [];
    for (const candidate of candidates) {
      const sourceHtml = candidate?.data?.parserAudit?.sourceHtml || candidate?.data?.sourceHtml || '';
      if (!sourceHtml) continue;
      const sanitizedHtml = sanitizeHtml(sourceHtml, replacements);
      const signature = hash(`${candidate.data.phase || ''}\n${sanitizedHtml}`);
      if (seen.has(signature)) continue;
      seen.add(signature);
      selected.push({ ...candidate, sourceHtml: sanitizedHtml, signature });
      if (selected.length >= MAX_SNAPSHOTS_PER_REQUEST) break;
    }
    if (!selected.length) return [];

    const requestKey = safeName(requestId || `request-${Date.now()}`);
    const scenarioKey = safeName(scope);
    const directory = path.join(outputDir, scenarioKey, requestKey);
    await fs.mkdir(directory, { recursive: true });
    const written = [];
    for (const [snapshotIndex, candidate] of selected.entries()) {
      const phase = safeName(candidate.data.phase || candidate.data.domPhase || (candidate.terminal ? 'terminal' : 'snapshot'));
      const basename = `${String(snapshotIndex + 1).padStart(2, '0')}-${phase}-${candidate.signature}`;
      const htmlName = `${basename}.html`;
      const fixtureName = `${basename}.fixture.json`;
      const fixture = {
        schemaVersion: FIXTURE_SCHEMA_VERSION,
        capturedAt: new Date().toISOString(),
        scenario: scope,
        requestId: requestKey,
        source: {
          eventId: String(candidate.eventId || ''),
          observedAt: String(candidate.at || ''),
          terminal: Boolean(candidate.terminal),
          html: htmlName,
          htmlSha256: createHash('sha256').update(candidate.sourceHtml).digest('hex'),
        },
        expected: normalizedExpected(candidate.data, replacements),
      };
      await Promise.all([
        fs.writeFile(path.join(directory, htmlName), `${candidate.sourceHtml}\n`),
        fs.writeFile(path.join(directory, fixtureName), `${JSON.stringify(fixture, null, 2)}\n`),
      ]);
      const record = { scenario: scope, requestId: requestKey, fixture: path.relative(outputDir, path.join(directory, fixtureName)), html: path.relative(outputDir, path.join(directory, htmlName)) };
      index.push(record);
      written.push(record);
    }
    if (canonical?.state) {
      const trace = requestTraceFromDiagnostics(canonical, { requestId: requestId || canonical.state.requestId || '', reason: `DOM fixture capture: ${scope}` });
      await fs.writeFile(path.join(directory, 'request-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
    }
    await fs.writeFile(path.join(outputDir, 'index.json'), `${JSON.stringify({ schemaVersion: FIXTURE_SCHEMA_VERSION, generatedAt: new Date().toISOString(), fixtures: index }, null, 2)}\n`);
    log('ok', scope, 'Captured sanitized DOM fixtures for offline parser/reducer tests', { requestId, fixtures: written.length, directory });
    return written;
  }

  return Object.freeze({ enabled: Boolean(enabled), outputDir, capture });
}
