import path from 'node:path';
import { normalizeHistoryRecord } from './terlioPromptEditor.js';

export const MAX_INPUT_HISTORY = 100;

export function inputHistoryScopeKey(state = {}, fallbackDirectory = process.cwd()) {
  const root = String(state.projectRoot || fallbackDirectory || process.cwd());
  return path.resolve(root);
}

export function readInputHistory(state = {}, scopeKey = inputHistoryScopeKey(state)) {
  const source = state.inputHistories?.[scopeKey];
  return Array.isArray(source)
    ? source.map(normalizeHistoryRecord).filter((item) => item.text).slice(0, MAX_INPUT_HISTORY)
    : [];
}

export function writeInputHistory(state = {}, scopeKey, history = []) {
  if (!state.inputHistories || typeof state.inputHistories !== 'object') state.inputHistories = {};
  state.inputHistories[scopeKey] = history
    .map(normalizeHistoryRecord)
    .filter((item) => item.text)
    .slice(0, MAX_INPUT_HISTORY);
  return state.inputHistories[scopeKey];
}

export function addInputHistoryRecord(history = [], record = {}) {
  const normalized = normalizeHistoryRecord(record);
  if (!normalized.text.trim()) return history.slice(0, MAX_INPUT_HISTORY);
  return [normalized, ...history.filter((item) => normalizeHistoryRecord(item).text !== normalized.text)]
    .slice(0, MAX_INPUT_HISTORY);
}
