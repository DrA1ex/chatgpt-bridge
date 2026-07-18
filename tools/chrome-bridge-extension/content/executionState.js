(() => {
  'use strict';

  const SCHEMA_VERSION = 4;
  const HANDLE = Symbol('chatgpt.execution.handle');
  const JOURNAL_LIMIT = 200;
  const LIFECYCLES = new Set(['idle', 'claimed', 'reconciling', 'executing', 'releasing']);
  const LIFECYCLE_TRANSITIONS = Object.freeze({
    claimed: new Set(['reconciling', 'executing', 'releasing']),
    reconciling: new Set(['executing', 'releasing']),
    executing: new Set(['reconciling', 'releasing']),
    releasing: new Set(['idle']),
  });

  function cloneProjection(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(cloneProjection);
    if (value instanceof Set) return new Set(value);
    if (value instanceof Map) return new Map(value);
    if (typeof Node !== 'undefined' && value instanceof Node) return value;
    const clone = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneProjection(item);
    return clone;
  }

  function frozenProjection(data) {
    return Object.freeze({ ...data });
  }

  function createInitialState() {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      lifecycle: 'idle',
      lease: null,
      request: null,
      journal: Object.freeze([]),
      updatedAt: 0,
    });
  }

  function appendJournal(state, event, accepted, reason = '') {
    return Object.freeze([...state.journal, Object.freeze({
      revision: state.revision + (accepted ? 1 : 0),
      type: String(event?.type || 'unknown'),
      accepted,
      reason,
      at: Number(event?.at) || Date.now(),
    })].slice(-JOURNAL_LIMIT));
  }

  function reduce(state, event) {
    const reject = (reason) => ({
      accepted: false,
      reason,
      state: Object.freeze({ ...state, journal: appendJournal(state, event, false, reason) }),
    });
    if (!event || typeof event.type !== 'string') {
      return reject('invalid_event');
    }
    if (event.expectedRevision != null && event.expectedRevision !== state.revision) {
      return reject('stale_revision');
    }
    const commit = (patch) => ({ accepted: true, state: Object.freeze({
      ...state,
      ...patch,
      revision: state.revision + 1,
      journal: appendJournal(state, event, true),
      updatedAt: Number(event.at) || Date.now(),
    }) });

    if (event.type === 'request.claimed') {
      if (state.request?.requestId === event.request?.requestId) return reject('duplicate_request');
      if (state.request || state.lifecycle !== 'idle') return reject('request_conflict');
      return commit({ lifecycle: 'claimed', lease: event.lease || state.lease, request: frozenProjection(cloneProjection(event.request || {})) });
    }
    if (event.type === 'request.recovered') {
      if (!event.lease?.requestId) return reject('lease_missing');
      if (!event.request?.requestId || event.request.requestId !== event.lease.requestId) return reject('recovery_projection_invalid');
      if (state.request && state.request.requestId !== event.lease.requestId) return reject('request_conflict');
      if (state.lifecycle === 'releasing') return reject('lifecycle_transition_invalid');
      return commit({
        lifecycle: 'reconciling',
        lease: Object.freeze({ ...event.lease }),
        request: frozenProjection(cloneProjection(event.request)),
      });
    }
    if (event.type === 'request.patched') {
      if (!state.request) return reject('request_missing');
      if (event.requestId && event.requestId !== state.request.requestId) return reject('request_mismatch');
      return commit({ request: frozenProjection({ ...state.request, ...event.patch }) });
    }
    if (event.type === 'request.lifecycle') {
      if (!LIFECYCLES.has(event.lifecycle)) return reject('lifecycle_invalid');
      if (!state.request) return reject('request_missing');
      if (!LIFECYCLE_TRANSITIONS[state.lifecycle]?.has(event.lifecycle)) return reject('lifecycle_transition_invalid');
      return commit({ lifecycle: event.lifecycle });
    }
    if (event.type === 'request.released') {
      if (!state.request || state.lifecycle === 'idle') return reject('request_missing');
      return commit({ lifecycle: 'idle', lease: null, request: null });
    }
    return reject('unknown_event');
  }

  function createRequestExecutionStore(options = {}) {
    const recoverRequest = options.recoverRequest;
    if (typeof recoverRequest !== 'function') throw new TypeError('Request execution store requires recoverRequest');
    let state = createInitialState();
    let handle = null;
    const resources = new Map();

    function dispatch(event) {
      const outcome = reduce(state, event);
      state = outcome.state;
      return outcome;
    }

    function ensureHandle() {
      if (handle || !state.request) return handle;
      handle = new Proxy({}, {
        get(_target, property) {
          if (property === HANDLE) return true;
          if (property === 'patch') return (patch) => dispatch({ type: 'request.patched', requestId: state.request?.requestId, patch });
          if (property === 'snapshot') return () => state.request;
          if (resources.has(property)) return resources.get(property);
          return state.request?.[property];
        },
        set(_target, property, value) {
          if (typeof value === 'function'
            || (typeof Node !== 'undefined' && value instanceof Node)
            || (typeof MutationObserver !== 'undefined' && value instanceof MutationObserver)
            || property === 'observer' || String(property).endsWith('Timer')) {
            resources.set(property, value);
            return true;
          }
          const outcome = dispatch({
            type: 'request.patched',
            requestId: state.request?.requestId,
            patch: { [property]: value },
          });
          return outcome.accepted;
        },
        ownKeys() { return [...new Set([...Reflect.ownKeys(state.request || {}), ...resources.keys()])]; },
        getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
      });
      return handle;
    }

    function setCurrent(request, lease = null) {
      if (!request) {
        resources.clear();
        handle = null;
        return dispatch({ type: 'request.released' });
      }
      if (request[HANDLE]) return { accepted: true, state };
      const outcome = dispatch({ type: 'request.claimed', request, lease });
      if (outcome.accepted) handle = null;
      return outcome;
    }

    function recover(recovery = {}) {
      if (!recovery.lease) return { accepted: false, reason: 'lease_missing', state };
      let request;
      try {
        request = recoverRequest(state.request ? cloneProjection(state.request) : null, recovery);
      } catch (error) {
        return { accepted: false, reason: 'recovery_projection_invalid', error, state };
      }
      resources.clear();
      handle = null;
      return dispatch({ type: 'request.recovered', lease: recovery.lease, request });
    }

    return Object.freeze({
      dispatch,
      getCurrent: () => ensureHandle(),
      getSnapshot: () => state,
      recover,
      setCurrent,
    });
  }

  globalThis.ChatGptRequestExecutionState = Object.freeze({
    SCHEMA_VERSION,
    createRequestExecutionStore,
    reduce,
  });
})();
