import { RequestTerminalCode } from './requestEvents.js';

const IMMEDIATE_TERMINAL_CODES = new Set([
  RequestTerminalCode.EXPLICIT_UI_ERROR,
  RequestTerminalCode.CONVERSATION_CHANGED,
  RequestTerminalCode.REQUEST_REPLACED,
]);

function errorCode(code = '') {
  return `CANONICAL_${String(code || 'request_failed').toUpperCase()}`;
}

export function immediateFailureFromCanonicalOutcome(outcome = null) {
  const terminal = outcome?.state?.terminal || null;
  if (!outcome?.accepted || !terminal || !IMMEDIATE_TERMINAL_CODES.has(terminal.code)) return null;

  const error = new Error(String(terminal.message || 'Canonical request state became terminal'));
  error.name = 'CanonicalRequestStateError';
  error.code = errorCode(terminal.code);
  error.phase = outcome.state?.lifecycle || 'failed';
  error.canonicalTerminal = terminal;
  return error;
}
