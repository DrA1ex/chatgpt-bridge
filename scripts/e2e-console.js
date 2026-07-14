import process from 'node:process';

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const ANSI = Object.freeze({
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  white: '\u001b[37m',
  gray: '\u001b[90m',
});

const LEVELS = Object.freeze({
  STEP: { color: 'cyan', symbol: '◆' },
  SEARCH: { color: 'blue', symbol: '⌕' },
  WAIT: { color: 'yellow', symbol: '…' },
  ACTION: { color: 'magenta', symbol: '▶' },
  RETRY: { color: 'yellow', symbol: '↻' },
  STATE: { color: 'blue', symbol: '●' },
  OK: { color: 'green', symbol: '✓' },
  INFO: { color: 'white', symbol: '•' },
  WARN: { color: 'yellow', symbol: '!' },
  FAIL: { color: 'red', symbol: '✗' },
});

export function stripAnsi(value = '') {
  return String(value || '').replace(ANSI_RE, '');
}

function padElapsed(ms) {
  const total = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function supportsColor(mode = 'auto') {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (process.env.NO_COLOR) return false;
  if (/^(1|true|always)$/i.test(String(process.env.FORCE_COLOR || ''))) return true;
  return Boolean(process.stdout.isTTY);
}

function valueText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function createE2eConsole({
  startedAt = Date.now(),
  colorMode = 'auto',
  appendPlainLine = () => {},
} = {}) {
  const colorEnabled = supportsColor(colorMode);
  const paint = (name, value) => colorEnabled ? `${ANSI[name] || ''}${value}${ANSI.reset}` : String(value);
  const bold = (value) => colorEnabled ? `${ANSI.bold}${value}${ANSI.reset}` : String(value);

  const renderFields = (fields = {}) => {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && value !== '');
    if (!entries.length) return '';
    return `  ${entries.map(([key, value]) => `${paint('gray', `${key}=`)}${bold(valueText(value))}`).join('  ')}`;
  };

  const write = (level, scope, message, fields = {}) => {
    const normalizedLevel = LEVELS[level] ? level : 'INFO';
    const meta = LEVELS[normalizedLevel];
    const elapsed = padElapsed(Date.now() - startedAt);
    const scopeText = scope ? `[${scope}]` : '';
    const plain = `${elapsed}  ${meta.symbol} ${normalizedLevel.padEnd(6)} ${scopeText ? `${scopeText} ` : ''}${message}${renderFields(fields)}`;
    const emphasizedMessage = ['STEP', 'ACTION', 'RETRY', 'OK', 'WARN', 'FAIL'].includes(normalizedLevel)
      ? bold(message)
      : message;
    const colored = `${paint('gray', elapsed)}  ${paint(meta.color, `${meta.symbol} ${normalizedLevel.padEnd(6)}`)} ${scopeText ? `${paint('cyan', bold(scopeText))} ` : ''}${emphasizedMessage}${renderFields(fields)}`;
    console.log(colored);
    appendPlainLine(stripAnsi(plain));
  };

  return {
    colorEnabled,
    write,
    step: (scope, message, fields) => write('STEP', scope, message, fields),
    search: (scope, message, fields) => write('SEARCH', scope, message, fields),
    wait: (scope, message, fields) => write('WAIT', scope, message, fields),
    action: (scope, message, fields) => write('ACTION', scope, message, fields),
    retry: (scope, message, fields) => write('RETRY', scope, message, fields),
    state: (scope, message, fields) => write('STATE', scope, message, fields),
    ok: (scope, message, fields) => write('OK', scope, message, fields),
    info: (scope, message, fields) => write('INFO', scope, message, fields),
    warn: (scope, message, fields) => write('WARN', scope, message, fields),
    fail: (scope, message, fields) => write('FAIL', scope, message, fields),
  };
}
