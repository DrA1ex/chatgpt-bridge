const COMPACTION_DEFAULT_TARGET_BYTES = 1_500_000;
const COMPACTION_AGGRESSIVE_TARGET_BYTES = 900_000;
const COMPACTION_COMMAND_RESULT_RETAIN_BYTES = 48_000;
const COMPACTION_EFFECT_VALUE_RETAIN_BYTES = 48_000;
const COMPACTION_RECENT_TERMINAL_COMMANDS = 32;
const COMPACTION_RECENT_TERMINAL_EFFECTS = 32;
const COMPACTION_RECENT_TERMINAL_DOWNLOADS = 24;
const COMPACTION_JOURNAL_LIMIT = 96;
const AGGRESSIVE_COMPACTION_JOURNAL_LIMIT = 32;

const COMPACTION_ACTIVE_COMMAND_STATUSES = new Set(['registered', 'dispatched', 'accepted', 'uncertain']);
const COMPACTION_ACTIVE_EFFECT_STATUSES = new Set(['planned', 'dispatched', 'uncertain']);
const COMPACTION_ACTIVE_DOWNLOAD_STATUSES = new Set(['planned', 'armed', 'bound']);


export function hasRecoveryCriticalState(state = null) {
  if (!state || typeof state !== 'object') return false;
  if (state.lease) return true;
  if (Array.isArray(state.outbox) && state.outbox.length > 0) return true;
  if (Object.values(state.commands || {}).some((command) => COMPACTION_ACTIVE_COMMAND_STATUSES.has(String(command?.status || '')))) return true;
  if (Object.values(state.effects || {}).some((effect) => COMPACTION_ACTIVE_EFFECT_STATUSES.has(String(effect?.status || '')))) return true;
  if (Object.values(state.downloads || {}).some((download) => COMPACTION_ACTIVE_DOWNLOAD_STATUSES.has(String(download?.status || '')))) return true;
  return false;
}

function jsonText(value) {
  try { return JSON.stringify(value); } catch { return ''; }
}

export function estimateRuntimeStateBytes(value) {
  const encoded = jsonText(value);
  if (!encoded) return Number.POSITIVE_INFINITY;
  try { return new TextEncoder().encode(encoded).byteLength; }
  catch { return encoded.length * 2; }
}

function compactValue(value, limitBytes, label) {
  if (value == null) return null;
  const encoded = jsonText(value);
  if (!encoded) return { compacted: true, label, reason: 'not_json_serializable' };
  const bytes = estimateRuntimeStateBytes(value);
  if (bytes <= limitBytes) return value;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    compacted: true,
    label,
    originalBytes: bytes,
    type: String(source.type || source.resultType || ''),
    code: String(source.code || ''),
    message: String(source.message || source.error || '').slice(0, 1_000),
  };
}

function outboxReferences(outbox = []) {
  const commandIds = new Set();
  const effectIds = new Set();
  const captureIds = new Set();
  for (const envelope of outbox || []) {
    const commandId = String(envelope?.commandId || envelope?.body?.commandId || '');
    const effectId = String(envelope?.effectId || envelope?.body?.effectId || '');
    const captureId = String(envelope?.body?.captureId || '');
    if (commandId) commandIds.add(commandId);
    if (effectId) effectIds.add(effectId);
    if (captureId) captureIds.add(captureId);
  }
  return { commandIds, effectIds, captureIds };
}

function sameLeaseRecord(record, lease) {
  if (!record || !lease) return false;
  return String(record.requestId || '') === String(lease.requestId || '')
    && String(record.leaseId || '') === String(lease.leaseId || '')
    && String(record.ownerServerInstanceId || '') === String(lease.ownerServerInstanceId || '');
}

function retainOrderedRecords(map = {}, order = [], protectedIds, recentLimit, aggressive) {
  const sourceOrder = order.filter((id) => map[id]);
  const keep = new Set(protectedIds);
  if (!aggressive) {
    for (const id of sourceOrder.slice().reverse()) {
      if (keep.size >= protectedIds.size + recentLimit) break;
      keep.add(id);
    }
  }
  const nextOrder = sourceOrder.filter((id) => keep.has(id));
  return {
    map: Object.fromEntries(nextOrder.map((id) => [id, map[id]])),
    order: nextOrder,
  };
}

function compactCommands(state, refs, aggressive) {
  const commands = state.commands || {};
  const protectedIds = new Set();
  for (const [id, command] of Object.entries(commands)) {
    if (refs.commandIds.has(id) || COMPACTION_ACTIVE_COMMAND_STATUSES.has(String(command?.status || '')) || sameLeaseRecord(command, state.lease)) {
      protectedIds.add(id);
    }
  }
  const retained = retainOrderedRecords(commands, state.commandOrder || [], protectedIds, COMPACTION_RECENT_TERMINAL_COMMANDS, aggressive);
  const compacted = {};
  for (const [id, command] of Object.entries(retained.map)) {
    const recoveryCritical = COMPACTION_ACTIVE_COMMAND_STATUSES.has(String(command?.status || ''));
    compacted[id] = {
      ...command,
      resultPayload: recoveryCritical
        ? command?.resultPayload
        : compactValue(command?.resultPayload, COMPACTION_COMMAND_RESULT_RETAIN_BYTES, 'command.resultPayload'),
    };
  }
  return { commands: compacted, commandOrder: retained.order };
}

function compactEffects(state, refs, aggressive) {
  const effects = state.effects || {};
  const protectedIds = new Set();
  for (const [id, effect] of Object.entries(effects)) {
    if (refs.effectIds.has(id) || COMPACTION_ACTIVE_EFFECT_STATUSES.has(String(effect?.status || '')) || sameLeaseRecord(effect, state.lease)) {
      protectedIds.add(id);
    }
  }
  const retained = retainOrderedRecords(effects, state.effectOrder || [], protectedIds, COMPACTION_RECENT_TERMINAL_EFFECTS, aggressive);
  const compacted = {};
  for (const [id, effect] of Object.entries(retained.map)) {
    const recoveryCritical = COMPACTION_ACTIVE_EFFECT_STATUSES.has(String(effect?.status || ''));
    compacted[id] = {
      ...effect,
      result: recoveryCritical
        ? effect?.result
        : compactValue(effect?.result, COMPACTION_EFFECT_VALUE_RETAIN_BYTES, 'effect.result'),
      error: recoveryCritical
        ? effect?.error
        : compactValue(effect?.error, COMPACTION_EFFECT_VALUE_RETAIN_BYTES, 'effect.error'),
      reconciliationEvidence: recoveryCritical
        ? effect?.reconciliationEvidence
        : compactValue(effect?.reconciliationEvidence, COMPACTION_EFFECT_VALUE_RETAIN_BYTES, 'effect.reconciliationEvidence'),
    };
  }
  return { effects: compacted, effectOrder: retained.order };
}

function compactDownloads(state, refs, aggressive) {
  const downloads = state.downloads || {};
  const protectedIds = new Set();
  for (const [id, download] of Object.entries(downloads)) {
    if (refs.captureIds.has(id) || COMPACTION_ACTIVE_DOWNLOAD_STATUSES.has(String(download?.status || '')) || sameLeaseRecord(download, state.lease)) {
      protectedIds.add(id);
    }
  }
  const ordered = Object.keys(downloads).sort((left, right) => {
    const a = Number(downloads[left]?.updatedAt || downloads[left]?.createdAt) || 0;
    const b = Number(downloads[right]?.updatedAt || downloads[right]?.createdAt) || 0;
    return a - b;
  });
  if (!aggressive) {
    for (const id of ordered.slice(-COMPACTION_RECENT_TERMINAL_DOWNLOADS)) protectedIds.add(id);
  }
  return Object.fromEntries(Object.entries(downloads).filter(([id]) => protectedIds.has(id)));
}

function compactOnce(state, aggressive) {
  const refs = outboxReferences(state.outbox || []);
  const commandPatch = compactCommands(state, refs, aggressive);
  const effectPatch = compactEffects(state, refs, aggressive);
  return {
    ...state,
    ...commandPatch,
    ...effectPatch,
    downloads: compactDownloads(state, refs, aggressive),
    journal: (state.journal || []).slice(-(aggressive ? AGGRESSIVE_COMPACTION_JOURNAL_LIMIT : COMPACTION_JOURNAL_LIMIT)),
  };
}

export function compactRuntimeState(state, options = {}) {
  const targetBytes = Math.max(256_000, Number(options.targetBytes) || COMPACTION_DEFAULT_TARGET_BYTES);
  const beforeBytes = estimateRuntimeStateBytes(state);
  let compacted = compactOnce(state, options.aggressive === true);
  let afterBytes = estimateRuntimeStateBytes(compacted);
  if (afterBytes > targetBytes && options.aggressive !== true) {
    compacted = compactOnce(compacted, true);
    afterBytes = estimateRuntimeStateBytes(compacted);
  }
  const changed = afterBytes < beforeBytes;
  const metrics = {
    ...(compacted.metrics || {}),
    persistenceBytes: Number.isFinite(afterBytes) ? afterBytes : 0,
    stateCompactions: (Number(state.metrics?.stateCompactions) || 0) + (changed ? 1 : 0),
    stateCompactedBytes: (Number(state.metrics?.stateCompactedBytes) || 0)
      + (changed && Number.isFinite(beforeBytes) && Number.isFinite(afterBytes) ? Math.max(0, beforeBytes - afterBytes) : 0),
  };
  return {
    state: { ...compacted, metrics },
    beforeBytes,
    afterBytes,
    changed,
    overTarget: afterBytes > targetBytes,
  };
}

export const BackgroundStateCompaction = Object.freeze({
  DEFAULT_TARGET_BYTES: COMPACTION_DEFAULT_TARGET_BYTES,
  AGGRESSIVE_TARGET_BYTES: COMPACTION_AGGRESSIVE_TARGET_BYTES,
});
