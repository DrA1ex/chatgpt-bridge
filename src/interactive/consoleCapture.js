import { inspect } from 'node:util';

function formatCapturedConsoleValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  return inspect(value, { colors: false, depth: 8, breakLength: 120 });
}

export async function captureConsoleLines(fn, onLine = null) {
  const lines = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  const capture = (level) => (...args) => {
    const line = args.map(formatCapturedConsoleValue).join(' ');
    lines.push(line);
    if (typeof onLine === 'function') onLine(line, level);
  };

  console.log = capture('log');
  console.info = capture('info');
  console.warn = capture('warn');
  console.error = capture('error');
  try {
    await fn();
    return lines.join('\n').trim();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
}
