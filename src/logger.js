let logEnabled = true;

export function setLogEnabled(enabled) {
  logEnabled = Boolean(enabled);
}

export function log(message, ...args) {
  if (!logEnabled) return;
  console.log(`[chatgpt-bridge] ${message}`, ...args);
}

export function error(message, err) {
  const suffix = err && err.stack ? `
${err.stack}` : err ? ` ${String(err)}` : '';
  console.error(`[chatgpt-bridge] ${message}${suffix}`);
}
