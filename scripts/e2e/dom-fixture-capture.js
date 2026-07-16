import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { requestTraceFromDiagnostics } from '../../src/bridge/replay/requestTrace.js';

const FIXTURE_SCHEMA_VERSION = 1;
const MAX_SNAPSHOTS_PER_REQUEST = 64;
const SENSITIVE_ATTRIBUTE = /^(?:nonce|integrity|data-token|data-auth|data-user-id|data-account-id)$/i;
const IDENTITY_ATTRIBUTE = /^(?:data-message-id|data-turn-id|data-turn-id-container)$/i;
const URL_ATTRIBUTE = /^(?:href|src|action|poster)$/i;
const CYRILLIC = /[\u0400-\u04ff]/u;
const LOCALIZED_UI_TEXT = Object.freeze(new Map([
  ['ChatGPT \u0441\u043a\u0430\u0437\u0430\u043b:', 'ChatGPT said:'],
  ['\u0417\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u044c', 'Run'],
  ['\u0411\u043e\u043b\u044c\u0448\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439', 'More actions'],
  ['\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u044f \u0441 \u043e\u0442\u0432\u0435\u0442\u043e\u043c', 'Response actions'],
  ['\u0417\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u044c \u043a\u043e\u0434', 'Run code'],
  ['\u041a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c', 'Copy'],
  ['\u041a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u043e\u0442\u0432\u0435\u0442', 'Copy response'],
  ['\u041f\u043b\u043e\u0445\u043e\u0439 \u043e\u0442\u0432\u0435\u0442', 'Bad response'],
  ['\u041f\u043e\u0434\u0435\u043b\u0438\u0442\u044c\u0441\u044f', 'Share'],
  ['\u0421\u043c\u0435\u043d\u0438\u0442\u044c \u043c\u043e\u0434\u0435\u043b\u044c', 'Switch model'],
  ['\u0425\u043e\u0440\u043e\u0448\u0438\u0439 \u043e\u0442\u0432\u0435\u0442', 'Good response'],
]));

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

function localizedUiReplacement(value = '') {
  const raw = String(value || '');
  return LOCALIZED_UI_TEXT.get(raw) || raw;
}

function localizedProgressReplacements(snapshot = {}) {
  const replacements = [];
  const counters = new Map();
  const seen = new Set();
  for (const item of Array.isArray(snapshot.progressItems) ? snapshot.progressItems : []) {
    const text = String(item?.text || '');
    if (!text || !CYRILLIC.test(text) || seen.has(text)) continue;
    seen.add(text);
    const kind = safeName(String(item?.kind || 'progress')).toUpperCase();
    const sequence = (counters.get(kind) || 0) + 1;
    counters.set(kind, sequence);
    const label = kind === 'THINKING'
      ? 'Captured thinking step'
      : kind === 'PROGRESS'
        ? 'Captured progress step'
        : kind === 'TOOL_STATUS'
          ? 'Captured tool step'
          : 'Captured action step';
    replacements.push([text, `${label} ${String(sequence).padStart(2, '0')}`]);
  }
  return replacements.sort((left, right) => String(right[0]).length - String(left[0]).length);
}

function replaceHtmlTextDynamicValues(html = '', replacements = []) {
  const tokens = String(html || '').match(/<[^>]*>|[^<]+/g) || [];
  const textSegments = [];
  let text = '';
  for (const [tokenIndex, token] of tokens.entries()) {
    if (token.startsWith('<')) continue;
    textSegments.push({ tokenIndex, start: text.length, end: text.length + token.length });
    text += token;
  }
  if (!text || !textSegments.length) return String(html || '');

  const ordered = replacements
    .filter(([from]) => from)
    .map(([from, to]) => [String(from), String(to)])
    .sort((left, right) => right[0].length - left[0].length);
  const edits = [];
  for (let index = 0; index < text.length;) {
    const replacement = ordered.find(([from]) => text.startsWith(from, index));
    if (!replacement) {
      index += 1;
      continue;
    }
    edits.push({ start: index, end: index + replacement[0].length, value: replacement[1] });
    index += replacement[0].length;
  }

  const locate = (offset, preferEnd = false) => {
    for (const segment of textSegments) {
      if (offset < segment.end || (preferEnd && offset === segment.end)) {
        return { segment, local: Math.max(0, Math.min(offset - segment.start, segment.end - segment.start)) };
      }
    }
    const segment = textSegments.at(-1);
    return { segment, local: segment.end - segment.start };
  };

  for (const edit of edits.reverse()) {
    const start = locate(edit.start);
    const end = locate(edit.end, true);
    const startToken = tokens[start.segment.tokenIndex];
    const endToken = tokens[end.segment.tokenIndex];
    if (start.segment.tokenIndex === end.segment.tokenIndex) {
      tokens[start.segment.tokenIndex] = `${startToken.slice(0, start.local)}${edit.value}${startToken.slice(end.local)}`;
      continue;
    }
    tokens[start.segment.tokenIndex] = `${startToken.slice(0, start.local)}${edit.value}`;
    for (const segment of textSegments) {
      if (segment.tokenIndex > start.segment.tokenIndex && segment.tokenIndex < end.segment.tokenIndex) tokens[segment.tokenIndex] = '';
    }
    tokens[end.segment.tokenIndex] = endToken.slice(end.local);
  }
  return tokens.join('');
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
  const textReplacements = [
    ...replacements,
    ...Array.from(LOCALIZED_UI_TEXT.entries()),
  ].sort((left, right) => String(right[0]).length - String(left[0]).length);
  let output = replaceHtmlTextDynamicValues(html, textReplacements)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, 'captured@example.invalid')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer REDACTED')
    .replace(/\b(?:sk|sess|token)[-_][A-Za-z0-9_-]{12,}\b/gi, 'REDACTED_TOKEN');
  output = output.replace(/\s([:\w-]+)=("[^"]*"|'[^']*')/g, (match, rawName, quotedValue) => {
    const name = String(rawName || '');
    const quote = quotedValue[0];
    const value = localizedUiReplacement(replaceDynamicValues(quotedValue.slice(1, -1), replacements));
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
    // A fixture is an isolated DOM snapshot. Completed hidden reasoning records
    // live only in the browser parser's in-memory registry and cannot be
    // reconstructed from this HTML file alone. Real E2E tests continue to
    // validate that accumulated history separately.
    progressItems: (snapshot.progressItems || []).filter((item) => item?.visible),
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

function snapshotsFromEvents(events = []) {
  const snapshots = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'assistant.dom.snapshot') continue;
    snapshots.push({
      at: event.time || event.createdAt || event.at || '',
      eventId: event.id || event.sequence || '',
      data: eventData(event),
    });
  }
  return snapshots;
}

function replayableTrace(trace = {}) {
  const firstType = String(trace?.events?.[0]?.event?.type || '');
  return firstType === 'request.created';
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
    const candidates = snapshotsFromEvents(events);
    if (!candidates.length && response?.parserAudit?.sourceHtml) {
      log('warn', scope, 'Skipped aggregate synchronous parser output because it is not a replayable DOM timeline snapshot', { requestId });
    }
    const seen = new Set();
    const selected = [];
    for (const candidate of candidates) {
      const sourceHtml = candidate?.data?.parserAudit?.sourceHtml || candidate?.data?.sourceHtml || '';
      if (!sourceHtml) continue;
      const candidateReplacements = [
        ...replacements,
        ...localizedProgressReplacements(candidate.data),
        ...Array.from(LOCALIZED_UI_TEXT.entries()),
      ].sort((left, right) => String(right[0]).length - String(left[0]).length);
      const sanitizedHtml = sanitizeHtml(sourceHtml, candidateReplacements);
      const signature = hash(`${candidate.data.phase || ''}\n${sanitizedHtml}`);
      if (seen.has(signature)) continue;
      seen.add(signature);
      selected.push({ ...candidate, sourceHtml: sanitizedHtml, signature, replacements: candidateReplacements });
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
        expected: normalizedExpected(candidate.data, candidate.replacements || replacements),
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
      if (replayableTrace(trace)) {
        await fs.writeFile(path.join(directory, 'request-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
      } else {
        log('warn', scope, 'Skipped incomplete canonical request trace during DOM fixture capture', {
          requestId,
          firstEvent: trace?.events?.[0]?.event?.type || '',
          events: trace?.events?.length || 0,
        });
      }
    }
    await fs.writeFile(path.join(outputDir, 'index.json'), `${JSON.stringify({ schemaVersion: FIXTURE_SCHEMA_VERSION, generatedAt: new Date().toISOString(), fixtures: index }, null, 2)}\n`);
    log('ok', scope, 'Captured sanitized DOM fixtures for offline parser/reducer tests', { requestId, fixtures: written.length, directory });
    return written;
  }

  return Object.freeze({ enabled: Boolean(enabled), outputDir, capture });
}
