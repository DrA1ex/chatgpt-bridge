import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { writeZip } from '../../../src/zipWriter.js';
import { markdownProjection } from './markdown.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);

function extractMarker(prompt = '') {
  return String(prompt).match(/\bBRIDGE_E2E_[A-Z0-9_]+\b/)?.[0]
    || String(prompt).match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)?.[0]
    || String(prompt).match(/\bmarker\s+([A-Z0-9_:-]+)/i)?.[1]
    || `MOCK_${Date.now()}`;
}

function requestedArtifactMarkers(prompt = '') {
  const source = String(prompt || '');
  const textMarker = source.match(/single line\s+([A-Z0-9_:-]+)/i)?.[1] || '';
  const jsonMarker = source.match(/\{["']marker["']\s*:\s*["']([A-Z0-9_:-]+)["']\}/i)?.[1] || '';
  const csvMarker = source.match(/marker\s*,\s*([A-Z0-9_:-]+)/i)?.[1] || '';
  const base = extractMarker(source).replace(/_(?:ONE|TWO|THREE)$/, '');
  return {
    text: textMarker || `${base}_ONE`,
    json: jsonMarker || `${base}_TWO`,
    csv: csvMarker || `${base}_THREE`,
  };
}

function extractExactToken(prompt = '') {
  const matches = [...String(prompt).matchAll(/(?:output|reply) exactly\s+([^\n.]+?)(?:\.|\n|$)/gi)];
  return (matches.at(-1)?.[1] || '')
    .trim()
    .replace(/^['"`]|['"`]$/g, '')
    .replace(/\s+(?:and nothing else|on its own final line)$/i, '')
    .trim();
}

async function zipBuffer(entries = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-mock-zip-'));
  const file = path.join(dir, 'artifact.zip');
  try {
    await writeZip(file, entries.map((entry) => ({ name: entry.name, data: Buffer.from(entry.data) })));
    return await fs.readFile(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function artifact(id, name, mime, buffer, options = {}) {
  return {
    id,
    candidateId: id,
    kind: mime === 'application/zip' ? 'archive' : 'file',
    name,
    fileName: name,
    mime,
    phase: 'READY',
    downloadable: true,
    downloadActionPresent: true,
    materializationSource: options.materializationSource || 'page-url',
    buffer: Buffer.from(buffer),
    ...options,
  };
}

function workflowArtifact(id, name, buffer) {
  return artifact(id, name, 'application/zip', buffer, {
    genericDownloadAction: true,
    actionLabel: 'Download the complete project ZIP',
  });
}

function completedArtifactToolStatus(label = 'Created downloadable files') {
  return [{
    id: `tool-status-${randomUUID()}`,
    logicalId: 'artifact-tool-status',
    kind: 'tool_status',
    text: String(label),
    state: 'completed',
    active: false,
    visible: true,
    revision: 1,
  }];
}

async function responseForPrompt(prompt, context = {}) {
  const source = String(prompt || '');
  const exact = extractExactToken(source);
  const payload = source.match(/PAYLOAD START\n\n([\s\S]*?)\n\nPAYLOAD END/);
  if (payload) return { answer: payload[1] };

  if (/reasoning test/i.test(source) && /TEST_/.test(source)) {
    const testId = source.match(/TEST_([^\s]+)_BEGIN/)?.[1] || 'MOCK';
    return {
      answer: `TEST_${testId}_BEGIN\n\n25502500\n\n\`\`\`javascript\nconsole.log((100 * 101 / 2) ** 2);\n\`\`\`\n\nTEST_${testId}_FINISH`,
      reasoning: true,
      progress: Array.from({ length: context.reasoningAttempt === 1 ? 10 : 11 }, (_, index) => index * 10),
    };
  }

  if (/sum of squares/i.test(source) && /STEER_RESULT RED/i.test(source)) {
    return {
      answer: 'STEER_RESULT RED',
      reasoning: true,
      progress: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90],
      progressDelayMs: 350,
    };
  }

  if (/98765431 is prime/i.test(source)) {
    const token = source.match(/finish with exactly\s+([^\s]+(?:_[^\s]+)*)/i)?.[1]?.replace(/[.`]+$/g, '') || exact;
    return { answer: `98765431 is composite because 98765431 = 13 × 7597333.\n${token}`, generationDelayMs: 3_000 };
  }

  if (/three separate downloadable files/i.test(source)) {
    const names = [...source.matchAll(/([\w.-]+\.(?:txt|json|csv))/g)].map((match) => match[1]).slice(0, 3);
    const markers = requestedArtifactMarkers(source);
    return {
      answer: '',
      progressItems: completedArtifactToolStatus('Created three downloadable files'),
      artifacts: [
        artifact(randomUUID(), names[0] || 'one.txt', 'text/plain', `${markers.text}\n`, { materializationSource: 'page-url' }),
        artifact(randomUUID(), names[1] || 'two.json', 'application/json', `${JSON.stringify({ marker: markers.json })}\n`, { materializationSource: 'chrome-downloads' }),
        artifact(randomUUID(), names[2] || 'three.csv', 'text/csv', `key,value\nmarker,${markers.csv}\n`, { materializationSource: 'chrome-downloads' }),
      ],
    };
  }

  if (/one real ZIP file named/i.test(source) && /alpha\.txt/i.test(source)) {
    const name = source.match(/named\s+([^\s]+\.zip)/i)?.[1] || 'mock.zip';
    const alpha = source.match(/alpha\.txt with content\s+([^\s]+)/i)?.[1] || 'ALPHA';
    const beta = source.match(/nested\/beta\.txt with content\s+([^\s.]+)/i)?.[1] || 'BETA';
    const buffer = await zipBuffer([{ name: 'alpha.txt', data: alpha }, { name: 'nested/beta.txt', data: beta }]);
    return {
      answer: '',
      progressItems: completedArtifactToolStatus('Created the requested ZIP archive'),
      artifacts: [artifact(randomUUID(), name, 'application/zip', buffer)],
    };
  }

  if (/VALIDATION_OUTPUT_BEGIN/i.test(source) && /return a new downloadable ZIP/i.test(source)) {
    const expectedValue = source.match(/REMEDIATION_FIXED_[A-Z0-9_]+/)?.[0]
      || source.match(/expected\s+([A-Z0-9_]+)/i)?.[1]
      || 'REMEDIATION_FIXED';
    const previous = context.previousWorkflowContext || {};
    const projectId = previous.projectId || 'mock-project';
    const packageName = previous.packageName || 'mock-project';
    const marker = previous.marker || extractMarker(source);
    const sourceLine = `export const value = "${expectedValue}";`;
    const entries = [
      { name: '.bridge/PROJECT_ID.json', data: `${JSON.stringify({ version: 1, projectId, projectName: 'workflow-e2e-fixture', packageName }, null, 2)}\n` },
      { name: 'package.json', data: `${JSON.stringify({ name: packageName, version: '1.0.0', type: 'module' }, null, 2)}\n` },
      { name: 'README.md', data: `# Mock workflow project\n\nMarker: ${marker}\n` },
      { name: 'src/index.js', data: `${sourceLine}\n` },
    ];
    const buffer = await zipBuffer(entries);
    return {
      answer: 'Created the corrected complete project ZIP.',
      artifacts: [workflowArtifact(randomUUID(), `${packageName}.zip`, buffer)],
      workflowContext: { projectId, packageName, marker, sourceLine },
    };
  }

  if (/Create one real downloadable ZIP artifact containing the complete project/i.test(source)) {
    const projectId = source.match(/projectId\s+([^\s.]+)/i)?.[1] || 'mock-project';
    const packageName = source.match(/package\.json name exactly\s+([^\s.]+)/i)?.[1] || 'mock-project';
    const sourceLine = source.match(/Set src\/index\.js to exactly:\s*([^\n]+)/i)?.[1] || 'export const value = "MOCK";';
    const marker = source.match(/workflow E2E marker\s+([^\s.]+)/i)?.[1] || extractMarker(source);
    const entries = [
      { name: '.bridge/PROJECT_ID.json', data: `${JSON.stringify({ version: 1, projectId, projectName: 'workflow-e2e-fixture', packageName }, null, 2)}\n` },
      { name: 'package.json', data: `${JSON.stringify({ name: packageName, version: '1.0.0', type: 'module' }, null, 2)}\n` },
      { name: 'README.md', data: `# Mock workflow project\n\nMarker: ${marker}\n` },
      { name: 'src/index.js', data: `${sourceLine}\n` },
    ];
    const buffer = await zipBuffer(entries);
    return {
      answer: 'Created the complete project ZIP.',
      artifacts: [workflowArtifact(randomUUID(), `${packageName}.zip`, buffer)],
      workflowContext: { projectId, packageName, marker, sourceLine },
    };
  }

  if (/Create result\.txt at the archive root/i.test(source)) {
    const seed = source.match(/seed=([^,\n]+)/)?.[1] || 'SEED';
    const agent = source.match(/agent=([^,\n]+)/)?.[1] || 'AGENT';
    const skill = source.match(/skill=([^,\n]+)/)?.[1] || 'SKILL';
    const result = `seed=${seed}\nagent=${agent}\nskill=${skill}\nrevision=1`;
    const projectFiles = [
      { name: 'seed.txt', data: `${seed}\n` },
      { name: 'AGENT.md', data: `For E2E output tasks, always include the literal token ${agent}. Do not omit it.\n` },
      { name: '.bridge/skills/deterministic.md', data: `When enabled, include the literal token ${skill} in result.txt.\n` },
      { name: 'result.txt', data: result },
    ];
    const buffer = await zipBuffer(projectFiles);
    return {
      answer: 'Created project revision 1.',
      artifacts: [artifact(randomUUID(), 'project-revision-1.zip', 'application/zip', buffer)],
      projectResult: result,
      projectFiles,
    };
  }

  if (/replace revision=1 with revision=2/i.test(source)) {
    const previous = source.match(/previous=([a-f0-9]+)/i)?.[1] || hash(context.previousProjectResult || '');
    const first = context.previousProjectResult || 'revision=1';
    const result = `${first.replace('revision=1', 'revision=2')}\nprevious=${previous}`;
    const retained = Array.isArray(context.previousProjectFiles)
      ? context.previousProjectFiles.filter((entry) => entry.name !== 'result.txt')
      : [];
    const projectFiles = [...retained, { name: 'result.txt', data: result }];
    const buffer = await zipBuffer(projectFiles);
    return {
      answer: 'Created project revision 2.',
      artifacts: [artifact(randomUUID(), 'project-revision-2.zip', 'application/zip', buffer)],
      projectResult: result,
      projectFiles,
    };
  }

  if (/add fallback\.txt/i.test(source)) {
    const value = source.match(/single line\s+([^\s.]+)/i)?.[1] || 'NO_CONTEXT';
    const buffer = await zipBuffer([{ name: 'plain.txt', data: 'plain\n' }, { name: 'fallback.txt', data: `${value}\n` }]);
    return { answer: 'Created the fallback project ZIP.', artifacts: [artifact(randomUUID(), 'project-fallback.zip', 'application/zip', buffer)] };
  }

  if (exact === 'MODEL_EFFORT_OK' && String(context.selectedEffort || '').toLowerCase() === 'instant') {
    return { answer: 'MOD' };
  }

  if (/Inspect the immediately previous assistant message/i.test(source)) {
    const expectedPrevious = source.match(/exactly\s+([^,]+), output exactly/i)?.[1]?.trim() || '';
    const success = source.match(/output exactly\s+([^\s.]+).*Otherwise output exactly/i)?.[1] || exact;
    const failure = source.match(/Otherwise output exactly\s+([^\s.]+)/i)?.[1] || 'MISMATCH';
    return { answer: String(context.previousAssistant || '').trim() === expectedPrevious ? success : failure };
  }

  return { answer: exact || `MOCK_RESPONSE_${hash(source)}` };
}

export class MockChatGptStateMachine {
  constructor({ tabId = 1, origin = 'http://bridge-e2e.localhost' } = {}) {
    this.tabId = tabId;
    this.origin = origin.replace(/\/$/, '');
    this.revision = 0;
    this.selectedModel = 'GPT-5.6 Sol';
    this.selectedEffort = 'high';
    this.sessions = new Map();
    this.sessionId = `mock-${randomUUID()}`;
    this.visibleConversationId = '';
    this.sessions.set(this.sessionId, { id: this.sessionId, title: 'Local E2E conversation', turns: [] });
    this.activeRequest = null;
    this.generating = false;
    this.steerReady = false;
    this.generationSequence = 0;
    this.activeGenerationSequence = 0;
    this.phase = 'idle';
    this.lastProjectResult = '';
    this.lastProjectFiles = [];
    this.lastWorkflowContext = null;
    this.attachments = [];
    this.transientRequestFailures = new Set();
    this.reasoningRequestCount = 0;
  }

  get session() { return this.sessions.get(this.sessionId); }
  get conversationId() { return this.visibleConversationId; }
  get url() { return this.visibleConversationId ? `${this.origin}/c/${this.visibleConversationId}` : `${this.origin}/`; }
  get turns() { return this.session?.turns || []; }

  sessionProjection() {
    return {
      id: this.visibleConversationId || 'new',
      url: this.url,
      title: this.session?.title || 'Local E2E conversation',
      active: true,
    };
  }

  beginConversationCanonicalization() {
    if (this.visibleConversationId) return null;
    const temporaryId = `WEB:${randomUUID()}`;
    this.visibleConversationId = temporaryId;
    this.revision += 1;
    return { temporaryId, canonicalId: this.sessionId };
  }

  completeConversationCanonicalization(expectedTemporaryId = '') {
    if (!expectedTemporaryId || this.visibleConversationId !== expectedTemporaryId) return false;
    this.visibleConversationId = this.sessionId;
    this.revision += 1;
    return true;
  }

  publicState() {
    return {
      tabId: this.tabId,
      revision: this.revision,
      title: 'Mock ChatGPT — Local E2E',
      phase: this.phase,
      sessionId: this.visibleConversationId || 'new',
      selectedModel: this.selectedModel,
      selectedEffort: this.selectedEffort,
      sessions: Array.from(this.sessions.values()).map(({ id, title }) => ({ id, title, url: `${this.origin}/c/${id}`, active: id === this.sessionId && this.visibleConversationId === id })),
      turns: this.turns.map((turn) => ({
        ...turn,
        artifacts: (turn.artifacts || []).map(({ buffer, ...item }) => ({
          ...item,
          previewText: /^text\/|json|csv/i.test(item.mime || '') && buffer.length <= 64 * 1024 ? buffer.toString('utf8') : '',
        })),
      })),
      attachments: this.attachments.map((item) => ({ ...item })),
      generating: this.generating,
      steerReady: this.steerReady,
    };
  }

  newSession() {
    this.attachments = [];
    this.sessionId = `mock-${randomUUID()}`;
    this.visibleConversationId = '';
    this.sessions.set(this.sessionId, { id: this.sessionId, title: `Conversation ${this.sessions.size + 1}`, turns: [] });
    this.revision += 1;
    return this.sessionProjection();
  }

  selectSession(sessionId) {
    this.attachments = [];
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { id: sessionId, title: `Conversation ${sessionId}`, turns: [] });
    this.sessionId = sessionId;
    this.visibleConversationId = sessionId;
    this.revision += 1;
    return this.sessionProjection();
  }

  deleteSession(sessionId) {
    if (sessionId !== this.sessionId) return { deleted: false, deletedSessionId: sessionId, beforeUrl: this.url, afterUrl: this.url };
    const beforeUrl = this.url;
    this.sessions.delete(sessionId);
    const next = this.sessions.keys().next().value;
    if (next) {
      this.sessionId = next;
      this.visibleConversationId = next;
    } else this.newSession();
    this.revision += 1;
    return { deleted: true, deletedSessionId: sessionId, beforeUrl, afterUrl: this.url };
  }

  setAttachments(attachments = []) {
    this.attachments = Array.from(attachments || []).map((item, index) => ({
      id: String(item?.id || `attachment-${index + 1}`),
      name: String(item?.name || item?.filename || `attachment-${index + 1}`),
      mime: String(item?.mime || item?.type || 'application/octet-stream'),
      size: Math.max(0, Number(item?.size) || 0),
    }));
    this.revision += 1;
    return this.attachments.map((item) => ({ ...item }));
  }

  removeAttachment(identity = '') {
    const target = String(identity || '');
    const before = this.attachments.length;
    this.attachments = this.attachments.filter((item) => item.id !== target && item.name !== target);
    if (this.attachments.length !== before) this.revision += 1;
    return { removed: before - this.attachments.length, attachments: this.attachments.map((item) => ({ ...item })) };
  }

  clearAttachments() {
    const removed = this.attachments.length;
    this.attachments = [];
    if (removed) this.revision += 1;
    return { removed, attachments: [] };
  }

  setIntelligence(options = {}) {
    if (options.model) this.selectedModel = String(options.model);
    if (options.effort) this.selectedEffort = String(options.effort);
    this.revision += 1;
    return this.intelligence();
  }

  intelligence() {
    return {
      models: [
        { id: 'model-gpt-5-6-sol', label: 'GPT-5.6 Sol', value: 'GPT-5.6 Sol', selected: this.selectedModel === 'GPT-5.6 Sol' },
        { id: 'model-gpt-5-6-thinking', label: 'GPT-5.6 Thinking', value: 'GPT-5.6 Thinking', selected: this.selectedModel === 'GPT-5.6 Thinking' },
      ],
      efforts: ['instant', 'low', 'medium', 'high', 'xhigh'].map((value) => ({ id: `effort-${value}`, label: value, value, selected: this.selectedEffort === value })),
      selectedModel: { id: `model-${this.selectedModel.toLowerCase().replace(/\W+/g, '-')}`, label: this.selectedModel, value: this.selectedModel },
      selectedEffort: { id: `effort-${this.selectedEffort}`, label: this.selectedEffort, value: this.selectedEffort },
      capturedAt: Date.now(),
    };
  }

  appendUser(text, request = null) {
    const key = `user-${randomUUID()}`;
    this.turns.push({ role: 'user', key, messageId: key, text: String(text), final: true });
    this.activeRequest = request ? { ...request, submittedUserTurnKey: key } : null;
    this.revision += 1;
    return key;
  }

  appendSteer(text, request = null) {
    const key = `steer-${randomUUID()}`;
    this.turns.push({ role: 'steer', key, messageId: key, text: String(text), final: true });
    this.activeRequest = request ? { ...request, submittedUserTurnKey: key } : this.activeRequest;
    this.revision += 1;
    return key;
  }

  async generate(prompt, { onChange = () => {}, request = null } = {}) {
    const reasoningAttempt = /reasoning test/i.test(String(prompt || '')) && /TEST_/.test(String(prompt || ''))
      ? ++this.reasoningRequestCount
      : 0;
    const plan = await responseForPrompt(prompt, {
      previousAssistant: [...this.turns].reverse().find((turn) => turn.role === 'assistant')?.text || '',
      previousProjectResult: this.lastProjectResult,
      previousProjectFiles: this.lastProjectFiles,
      previousWorkflowContext: this.lastWorkflowContext,
      selectedModel: this.selectedModel,
      selectedEffort: this.selectedEffort,
      reasoningAttempt,
    });
    const generationSequence = ++this.generationSequence;
    this.activeGenerationSequence = generationSequence;
    this.generating = true;
    this.steerReady = false;
    this.phase = plan.reasoning ? 'reasoning' : 'generating';
    const assistantKey = `assistant-${randomUUID()}`;
    const turn = { role: 'assistant', key: assistantKey, messageId: assistantKey, text: '', final: false, progressItems: [], artifacts: [] };
    this.turns.push(turn);
    if (this.activeRequest) this.activeRequest.assistantTurnKey = assistantKey;
    this.revision += 1;
    await onChange('generation-started');

    const isCurrentGeneration = () => this.activeGenerationSequence === generationSequence;
    if (plan.reasoning) {
      for (const percentage of plan.progress) {
        if (!isCurrentGeneration()) return turn;
        turn.progressItems = [{ logicalId: 'reasoning-main', id: 'reasoning-main', kind: 'thinking', text: `${percentage}%`, state: percentage === 100 ? 'completed' : 'active', active: percentage !== 100, visible: true, revision: percentage / 10 + 1 }];
        turn.text = '';
        this.steerReady = true;
        this.revision += 1;
        await onChange(`reasoning-${percentage}`);
        await delay(Math.max(10, Number(plan.progressDelayMs) || 90));
      }
    } else if (plan.generationDelayMs) {
      turn.text = 'Working…';
      this.steerReady = true;
      this.revision += 1;
      await onChange('generation-progress');
      await delay(plan.generationDelayMs);
    } else {
      await delay(80);
    }

    if (!isCurrentGeneration()) return turn;
    const effectiveRequest = request || this.activeRequest || null;
    const transientFailureKey = String(effectiveRequest?.requestId || effectiveRequest?.id || '') || hash(prompt);
    const shouldFailTransiently = /98765431 is prime/i.test(String(prompt || ''))
      && /reload/i.test(String(effectiveRequest?.requestId || effectiveRequest?.id || ''))
      && Number(effectiveRequest?.responseEpoch || 0) === 0
      && !this.transientRequestFailures.has(transientFailureKey);
    if (shouldFailTransiently) {
      this.transientRequestFailures.add(transientFailureKey);
      const submittedUser = [...this.turns].reverse().find((candidate) => candidate.role === 'user');
      if (submittedUser) {
        submittedUser.errorText = 'Что-то пошло не так. Попробуйте еще раз.';
        submittedUser.errorCode = 'CHATGPT_TRANSIENT_REQUEST_ERROR';
        submittedUser.errorKind = 'transient_request_error';
        submittedUser.errorRetryable = true;
      }
      turn.text = '';
      turn.final = true;
      this.generating = false;
      this.steerReady = false;
      this.phase = 'error';
      this.revision += 1;
      await onChange('transient-request-error');
      return turn;
    }
    turn.text = plan.answer;
    turn.progressItems = Array.isArray(plan.progressItems) ? plan.progressItems.map((item) => ({ ...item })) : turn.progressItems;
    turn.artifacts = plan.artifacts || [];
    turn.final = true;
    if (plan.projectResult) this.lastProjectResult = plan.projectResult;
    if (Array.isArray(plan.projectFiles)) this.lastProjectFiles = plan.projectFiles.map((entry) => ({ ...entry }));
    if (plan.workflowContext) this.lastWorkflowContext = { ...plan.workflowContext };
    if (!isCurrentGeneration()) return turn;
    this.activeGenerationSequence = 0;
    this.generating = false;
    this.steerReady = false;
    this.phase = 'idle';
    this.revision += 1;
    await onChange('generation-completed');
    return turn;
  }

  canSteer() {
    return Boolean(this.generating && this.steerReady
      && [...this.turns].reverse().some((turn) => turn.role === 'assistant' && !turn.final));
  }

  async steer(message, { onChange = () => {} } = {}) {
    if (!this.canSteer()) {
      const error = new Error('Mock ChatGPT steer control is unavailable before assistant progress');
      error.code = 'MOCK_STEER_NOT_READY';
      throw error;
    }
    const previous = [...this.turns].reverse().find((turn) => turn.role === 'assistant' && !turn.final);
    if (!previous) throw new Error('No active mock assistant turn to steer');
    previous.text = previous.text && previous.text !== 'Working…' ? previous.text : '';
    previous.final = true;
    const completedProgress = (previous.progressItems || []).map((item, index) => ({
      ...item,
      id: item.id || `reasoning-steer-${index + 1}`,
      logicalId: item.logicalId || 'reasoning-steer',
      state: 'completed',
      active: false,
      visible: true,
    }));
    previous.progressItems = completedProgress;
    const token = extractExactToken(message) || message.match(/STEER_RESULT\s+\w+/i)?.[0] || 'STEER_RESULT BLUE';
    const key = `assistant-${randomUUID()}`;
    const reasoningId = `reasoning-steer-${this.activeRequest?.responseEpoch ?? this.generationSequence}-${randomUUID()}`;
    const steered = {
      role: 'assistant',
      key,
      messageId: key,
      text: token,
      final: true,
      progressItems: [{
        id: reasoningId,
        logicalId: reasoningId,
        kind: 'thinking',
        text: 'Steering instruction applied.',
        state: 'completed',
        active: false,
        visible: true,
        revision: 1,
      }],
      artifacts: [],
    };
    this.turns.push(steered);
    if (this.activeRequest) this.activeRequest.assistantTurnKey = key;
    this.activeGenerationSequence = 0;
    this.generationSequence += 1;
    this.generating = false;
    this.steerReady = false;
    this.phase = 'idle';
    this.revision += 1;
    await onChange('generation-steered');
    return steered;
  }

  cancel() {
    this.activeGenerationSequence = 0;
    this.generationSequence += 1;
    this.generating = false;
    this.steerReady = false;
    this.phase = 'idle';
    const active = [...this.turns].reverse().find((turn) => turn.role === 'assistant' && !turn.final);
    if (active) { active.text = active.text || 'Cancelled'; active.final = true; }
    this.revision += 1;
  }

  artifactById(id) {
    for (const turn of this.turns) {
      const found = (turn.artifacts || []).find((item) => item.id === id || item.candidateId === id);
      if (found) return found;
    }
    return null;
  }

  outputSnapshot() {
    let user = null;
    let userIndex = -1;
    for (let index = this.turns.length - 1; index >= 0; index -= 1) {
      if (this.turns[index]?.role === 'user') {
        user = this.turns[index];
        userIndex = index;
        break;
      }
    }
    let assistant = null;
    for (let index = this.turns.length - 1; index > userIndex; index -= 1) {
      if (this.turns[index]?.role === 'assistant') {
        assistant = this.turns[index];
        break;
      }
    }
    const projection = markdownProjection(assistant?.text || '');
    const progressItems = assistant?.progressItems || [];
    const thinking = progressItems.map((item) => item.text).join('\n');
    return {
      assistant,
      user,
      answer: assistant?.final ? assistant.text : (assistant?.text === 'Working…' ? '' : assistant?.text || ''),
      thinking,
      progress: thinking,
      progressItems,
      reasoningHistory: progressItems.filter((item) => item.state === 'completed'),
      responseBlocks: projection.blocks,
      codeBlocks: projection.codeBlocks,
      parserAudit: projection.parserAudit,
      artifacts: assistant?.artifacts || [],
    };
  }
}
