export function resultError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  err.statusCode = extra.statusCode || 422;
  err.extra = extra;
  return err;
}

export function sleep(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}
