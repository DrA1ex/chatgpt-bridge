import fs from 'node:fs';
import path from 'node:path';

function compilePath(pattern = '/') {
  const names = [];
  const escaped = String(pattern || '/')
    .split('/')
    .map((part) => {
      if (!part) return '';
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${escaped || '/'}\/?$`), names };
}

function matchRoute(entry, pathname) {
  if (entry.middleware) return {};
  const match = entry.compiled.regex.exec(pathname);
  if (!match) return null;
  const params = {};
  entry.compiled.names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1] || ''); });
  return params;
}

function enhanceResponse(res) {
  if (res.__miniExpressEnhanced) return res;
  Object.defineProperty(res, '__miniExpressEnhanced', { value: true });
  res.status = (code) => { res.statusCode = Number(code) || 200; return res; };
  res.json = (value) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  res.send = (value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      if (!res.headersSent) res.setHeader('Content-Type', 'application/octet-stream');
      res.end(value);
    } else if (value && typeof value === 'object') {
      res.json(value);
    } else {
      if (!res.headersSent) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(String(value ?? ''));
    }
    return res;
  };
  res.download = (filePath, filename = path.basename(filePath)) => {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/octet-stream');
    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      if (!res.headersSent) res.statusCode = error?.code === 'ENOENT' ? 404 : 500;
      res.end(error?.message || 'Download failed');
    });
    stream.pipe(res);
    return res;
  };
  return res;
}

function createApplication({ isRouter = false } = {}) {
  const stack = [];
  const app = function miniExpressApplication(req, res, outerNext = null) {
    enhanceResponse(res);
    if (!req.originalUrl) req.originalUrl = req.url || '/';
    if (!req.path || !req.query) {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      req.path = parsed.pathname;
      req.query = Object.fromEntries(parsed.searchParams.entries());
    }
    if (!req.app || !isRouter) req.app = req.app || app;
    req.app.locals ||= {};
    let index = 0;

    const dispatch = (error = null) => {
      if (res.writableEnded) return;
      const entry = stack[index++];
      if (!entry) {
        if (outerNext) return outerNext(error || undefined);
        if (error) {
          res.statusCode = Number(error.statusCode) || 500;
          return res.json({ detail: error.message || 'Internal Server Error' });
        }
        res.statusCode = 404;
        return res.json({ detail: 'Not Found' });
      }
      const isErrorHandler = entry.handler.length === 4;
      if (error && !isErrorHandler) return dispatch(error);
      if (!error && isErrorHandler) return dispatch();
      if (entry.method && entry.method !== String(req.method || 'GET').toUpperCase()) return dispatch(error);
      const params = matchRoute(entry, req.path);
      if (params == null) return dispatch(error);
      const previousParams = req.params;
      req.params = params;
      let nextCalled = false;
      const next = (nextError) => {
        if (nextCalled) return;
        nextCalled = true;
        req.params = previousParams;
        dispatch(nextError || null);
      };
      try {
        const result = isErrorHandler
          ? entry.handler(error, req, res, next)
          : entry.handler(req, res, next);
        if (result && typeof result.then === 'function') result.catch(next);
      } catch (caught) {
        next(caught);
      }
    };
    dispatch();
  };

  app.locals = {};
  app.disable = () => app;
  app.use = (...args) => {
    const handler = args.length === 1 ? args[0] : args[1];
    if (typeof handler !== 'function') throw new TypeError('miniExpress.use requires a function');
    stack.push({ middleware: true, method: '', path: '', compiled: null, handler });
    return app;
  };
  for (const method of ['get', 'post', 'delete', 'put', 'patch']) {
    app[method] = (routePath, ...handlers) => {
      for (const handler of handlers) {
        if (typeof handler !== 'function') throw new TypeError(`miniExpress.${method} requires a handler`);
        stack.push({ middleware: false, method: method.toUpperCase(), path: routePath, compiled: compilePath(routePath), handler });
      }
      return app;
    };
  }
  app.__miniExpressStack = stack;
  return app;
}

function parseLimit(value) {
  if (typeof value === 'number') return value;
  const match = String(value || '1mb').trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  if (!match) return 1024 * 1024;
  const number = Number(match[1]);
  const unit = String(match[2] || 'b').toLowerCase();
  const multiplier = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  return Math.floor(number * multiplier);
}

function jsonMiddleware(options = {}) {
  const limit = parseLimit(options.limit || '1mb');
  return (req, _res, next) => {
    if (req.body !== undefined) return next();
    const method = String(req.method || 'GET').toUpperCase();
    if (['GET', 'HEAD'].includes(method)) { req.body = {}; return next(); }
    const contentType = String(req.headers?.['content-type'] || '');
    if (!/application\/json/i.test(contentType)) { req.body = {}; return next(); }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; next(error); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Request body too large');
        error.statusCode = 413;
        req.destroy(error);
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', fail);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { req.body = {}; next(); return; }
      try { req.body = JSON.parse(raw); next(); }
      catch {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        next(error);
      }
    });
  };
}

export function createMiniExpress() { return createApplication(); }
createMiniExpress.Router = () => createApplication({ isRouter: true });
createMiniExpress.json = jsonMiddleware;
export default createMiniExpress;
