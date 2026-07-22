import fs from 'node:fs/promises';
import path from 'node:path';

const nowIso = () => new Date().toISOString();
const eventData = (event = {}) => event?.data && typeof event.data === 'object' ? event.data : event;

function parserObservationBlockText(block = {}, index = 0) {
  const lines = [`[${index}] ${block.type || 'unknown'}`];
  if (block.language) lines.push(`Language: ${block.language}`);
  if (block.diagnostic?.source) lines.push(`Language source: ${block.diagnostic.source}`);
  if (block.diagnostic?.confidence) lines.push(`Language confidence: ${block.diagnostic.confidence}`);
  if (block.code !== undefined) {
    lines.push('Code:');
    lines.push(String(block.code || ''));
  } else {
    lines.push('Markdown:');
    lines.push(String(block.markdown || block.text || ''));
  }
  if (Array.isArray(block.diagnostic?.unknownChildren) && block.diagnostic.unknownChildren.length) {
    lines.push('Unknown children:');
    for (const item of block.diagnostic.unknownChildren) lines.push(`- ${item.domPath || '(no path)'} :: ${item.text || ''}`);
  }
  return lines.join('\n');
}

function parserObservationSnapshotText(snapshot = {}, index = 0, metadata = {}) {
  const audit = snapshot.parserAudit || {};
  const coverage = audit.coverage || {};
  const progressItems = Array.isArray(snapshot.progressItems) ? snapshot.progressItems : [];
  const blocks = Array.isArray(snapshot.responseBlocks) ? snapshot.responseBlocks : [];
  const interfaceItems = Array.isArray(audit.interfaceItems) ? audit.interfaceItems : [];
  const artifactItems = Array.isArray(audit.artifactItems) ? audit.artifactItems : [];
  const interfaceControls = Array.isArray(audit.interfaceControls) ? audit.interfaceControls : [];
  const unknownItems = Array.isArray(audit.unknownItems) ? audit.unknownItems : [];
  const duplicateItems = Array.isArray(audit.duplicateItems) ? audit.duplicateItems : [];
  const lines = [
    '='.repeat(72),
    `${metadata.terminal ? 'FINAL TERMINAL SNAPSHOT' : `SNAPSHOT ${index}`}`,
    `Timestamp: ${metadata.at || nowIso()}`,
    `DOM phase: ${snapshot.phase || snapshot.domPhase || 'unknown'}`,
    `Turn key: ${snapshot.turnKey || ''}`,
    '='.repeat(72),
    '',
    'RAW VISIBLE ASSISTANT TURN',
    '--------------------------',
    String(snapshot.rawText || snapshot.raw || ''),
    '',
    'PARSED RESPONSE BLOCKS',
    '----------------------',
    blocks.length ? blocks.map(parserObservationBlockText).join('\n\n') : 'None',
    '',
    'REASONING / PROGRESS BLOCKS',
    '---------------------------',
    progressItems.length ? progressItems.map((item, itemIndex) => [
      `[${itemIndex}] kind=${item.kind || 'progress'} state=${item.state || ''} revision=${item.revision || 0} active=${Boolean(item.active)} visible=${Boolean(item.visible)}`,
      String(item.text || ''),
    ].join('\n')).join('\n\n') : 'None',
    '',
    'ARTIFACT CONTENT',
    '----------------',
    artifactItems.length ? artifactItems.map((item, itemIndex) => `[${itemIndex}] ${item.domPath || ''} :: ${item.text || item.ariaLabel || ''}`).join('\n') : 'None',
    '',
    'EXCLUDED INTERFACE',
    '------------------',
    (interfaceItems.length || interfaceControls.length) ? [
      ...interfaceItems.map((item, itemIndex) => `[leaf ${itemIndex}] ${item.reason || item.category || 'interface'} ${item.domPath || ''} :: ${item.text || item.ariaLabel || ''}`),
      ...interfaceControls.map((item, itemIndex) => `[control ${itemIndex}] ${item.kind || item.role || 'control'} ${item.domPath || ''} :: ${item.ariaLabel || item.title || item.text || ''}`),
    ].join('\n') : 'None',
    '',
    'UNKNOWN VISIBLE CONTENT',
    '-----------------------',
    unknownItems.length ? unknownItems.map((item, itemIndex) => `[${itemIndex}] ${item.reason || item.category || 'unknown'} ${item.domPath || ''} :: ${item.text || item.alt || item.ariaLabel || ''}`).join('\n') : 'None',
    '',
    'DUPLICATE OWNERSHIP',
    '-------------------',
    duplicateItems.length ? duplicateItems.map((item, itemIndex) => `[${itemIndex}] ${item.domPath || ''} owners=${JSON.stringify(item.ownerIndexes || [])} :: ${item.text || ''}`).join('\n') : 'None',
    '',
    'COVERAGE',
    '--------',
    `Visible text leaves: ${coverage.visibleTextLeaves ?? 0}`,
    `Content leaves: ${coverage.contentLeaves ?? 0}`,
    `Interface leaves: ${coverage.interfaceLeaves ?? 0}`,
    `Artifact leaves: ${coverage.artifactLeaves ?? 0}`,
    `Reasoning phases: ${coverage.reasoningLeaves ?? 0}`,
    `Unknown leaves: ${coverage.unknownLeaves ?? 0}`,
    `Unknown visual elements: ${coverage.unknownVisualElements ?? 0}`,
    `Duplicate leaves: ${coverage.duplicateLeaves ?? 0}`,
    `Coverage: ${coverage.coveragePercent ?? 0}%`,
    `Warnings: ${(audit.warnings || []).join(', ') || 'None'}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function createParserObservationWriter(filePath) {
  const seen = new Set();
  let snapshotIndex = 0;
  return {
    async initialize() {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `ChatGPT response parser live observation\nCreated: ${nowIso()}\n\n`);
    },
    async consume(events = []) {
      for (const event of Array.isArray(events) ? events : []) {
        if (event?.type !== 'assistant.dom.snapshot') continue;
        const data = eventData(event);
        const key = String(event.id || event.sequence || `${event.time || event.createdAt || ''}:${data.signature || ''}`);
        if (seen.has(key)) continue;
        seen.add(key);
        snapshotIndex += 1;
        await fs.appendFile(filePath, parserObservationSnapshotText(data, snapshotIndex, { at: event.time || event.createdAt || event.at || '' }));
      }
    },
    async appendTerminal(snapshot = {}, metadata = {}) {
      await fs.appendFile(filePath, parserObservationSnapshotText(snapshot, snapshotIndex + 1, { ...metadata, terminal: true }));
    },
    get snapshotCount() { return snapshotIndex; },
    filePath,
  };
}


export function reasoningSnapshotsFromEvents(events = []) {
  const source = Array.isArray(events) ? events : [];
  const domSnapshots = source
    .filter((event) => event?.type === 'assistant.dom.snapshot')
    .map(eventData);
  if (domSnapshots.length) return domSnapshots;

  const snapshots = [];
  let progressItems = [];
  for (const event of source) {
    const data = eventData(event);
    if (event?.type === 'assistant.progress.snapshot') {
      progressItems = Array.isArray(data.items) ? data.items.map((item) => ({ ...item })) : progressItems;
      snapshots.push({
        phase: 'reasoning',
        domPhase: 'reasoning',
        turnKey: String(data.assistantTurnKey || ''),
        observationRevision: Number(data.observationRevision) || 0,
        progressItems: progressItems.map((item) => ({ ...item })),
        thinking: String(data.text || ''),
        progress: String(data.text || ''),
        answer: '',
        raw: String(data.text || ''),
        rawText: String(data.text || ''),
        source: 'canonical-progress-events',
      });
      continue;
    }
    if (event?.type === 'answer.snapshot') {
      snapshots.push({
        phase: 'final',
        domPhase: 'final',
        turnKey: String(data.assistantTurnKey || ''),
        observationRevision: Number(data.observationRevision) || 0,
        progressItems: progressItems.map((item) => ({ ...item })),
        thinking: progressItems.map((item) => String(item.text || '')).filter(Boolean).join('\n'),
        progress: progressItems.map((item) => String(item.text || '')).filter(Boolean).join('\n'),
        answer: String(data.text || ''),
        raw: String(data.text || ''),
        rawText: String(data.text || ''),
        source: 'canonical-answer-events',
      });
    }
  }
  return snapshots;
}

export function firstDifference(left = '', right = '') {
  const a = String(left); const b = String(right); const limit = Math.min(a.length, b.length);
  let offset = 0; while (offset < limit && a[offset] === b[offset]) offset += 1;
  if (offset === a.length && offset === b.length) return null;
  return { offset, expected: a.slice(offset, offset + 80), actual: b.slice(offset, offset + 80), expectedLength: a.length, actualLength: b.length };
}

export function logicalProgressId(item = {}, index = 0) {
  return String(item?.id || item?.key || `${item?.kind || 'progress'}:${item?.structuralHint || index}`);
}

export function mergeObservedProgress(items = []) {
  const order = []; const map = new Map();
  for (const item of items) {
    const id = logicalProgressId(item, order.length); const previous = map.get(id);
    if (!previous) order.push(id);
    if (!previous || Number(item?.revision || 0) >= Number(previous?.revision || 0) || (!previous?.text && item?.text)) map.set(id, { ...previous, ...item, id });
  }
  return order.map((id) => map.get(id));
}

export function progressRevisionTimeline(domSnapshots = []) {
  const timeline = [];
  const lastSignatureById = new Map();
  for (const [snapshotIndex, snapshot] of (Array.isArray(domSnapshots) ? domSnapshots : []).entries()) {
    for (const [itemIndex, item] of (Array.isArray(snapshot?.progressItems) ? snapshot.progressItems : []).entries()) {
      const id = logicalProgressId(item, itemIndex);
      const entry = {
        snapshotIndex,
        id,
        kind: String(item?.kind || ''),
        revision: Number(item?.revision || 0),
        state: String(item?.state || ''),
        active: Boolean(item?.active),
        visible: Boolean(item?.visible),
        text: String(item?.text || ''),
      };
      const signature = JSON.stringify([entry.revision, entry.state, entry.active, entry.visible, entry.text]);
      if (lastSignatureById.get(id) === signature) continue;
      lastSignatureById.set(id, signature);
      timeline.push(entry);
    }
  }
  return timeline;
}
