(() => {
  'use strict';

  const CommandMode = Object.freeze({
    RESULT: 'result',
    EFFECT: 'effect',
    RELEASE: 'release',
  });
  const CommandScope = Object.freeze({
    STANDALONE: 'standalone',
    REQUEST: 'request',
    EITHER: 'either',
  });
  const CommandOperation = Object.freeze({
    READ: 'read',
    WRITE: 'write',
    CONTROL: 'control',
    MAINTENANCE: 'maintenance',
  });

  function text(value) { return String(value ?? '').trim(); }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
  function array(value) { return Array.isArray(value) ? value : null; }
  function issue(errors, condition, message) { if (!condition) errors.push(message); }
  function effectDescriptor(errors, payload, field = 'effect') {
    const descriptor = object(payload?.[field]);
    issue(errors, descriptor, `${field} descriptor is required`);
    if (!descriptor) return;
    issue(errors, text(descriptor.effectId), `${field}.effectId is required`);
    issue(errors, text(descriptor.kind), `${field}.kind is required`);
    issue(errors, text(descriptor.idempotencyKey), `${field}.idempotencyKey is required`);
    issue(errors, text(descriptor.preconditionsHash), `${field}.preconditionsHash is required`);
  }

  const validators = Object.freeze({
    none() { return []; },
    promptSend(payload) {
      const errors = [];
      const attachments = array(payload.attachments) || [];
      issue(errors, text(payload.message) || attachments.length > 0, 'prompt.send requires message or attachments');
      issue(errors, object(payload.executionPlan), 'prompt.send executionPlan is required');
      issue(errors, payload.executionStepOnly === true, 'prompt.send executionStepOnly must be true');
      return errors;
    },
    promptSteer(payload) {
      const errors = [];
      issue(errors, text(payload.message), 'prompt.steer message is required');
      effectDescriptor(errors, payload);
      return errors;
    },
    promptCancel(payload) {
      const errors = [];
      effectDescriptor(errors, payload);
      return errors;
    },
    commandCancel(payload) {
      const errors = [];
      issue(errors, text(payload.targetCommandId), 'command.cancel targetCommandId is required');
      return errors;
    },
    passivePrompt(payload) {
      const errors = [];
      issue(errors, text(payload.message), 'passive.prompt.submit message is required');
      return errors;
    },
    sessionSelect(payload) {
      const errors = [];
      issue(errors, text(payload.sessionId), 'sessions.select sessionId is required');
      return errors;
    },
    sessionDelete(payload) {
      const errors = [];
      issue(errors, text(payload.sessionId), 'sessions.delete sessionId is required');
      issue(errors, text(payload.expectedUrl), 'sessions.delete expectedUrl is required');
      return errors;
    },
    intelligence(payload) {
      const errors = [];
      const options = object(payload.options);
      issue(errors, options, 'intelligence.apply options are required');
      issue(errors, options && (text(options.model) || text(options.effort)), 'intelligence.apply requires model or effort');
      return errors;
    },
    artifactFetch(payload) {
      const errors = [];
      const artifact = object(payload.artifact);
      issue(errors, artifact, 'artifact.fetch artifact is required');
      issue(errors, artifact && (text(artifact.id) || text(artifact.url) || text(artifact.src) || text(artifact.downloadUrl)), 'artifact.fetch artifact identity is required');
      return errors;
    },
    recoverTurn(payload) {
      const errors = [];
      issue(errors, text(payload.turnKey), 'response.recover.turnKey turnKey is required');
      return errors;
    },
    effectReconcile(payload) {
      const errors = [];
      issue(errors, text(payload.effectId), 'request.effect.reconcile effectId is required');
      issue(errors, text(payload.effectType), 'request.effect.reconcile effectType is required');
      issue(errors, ['never', 'if_unconfirmed', 'always'].includes(text(payload.retryPolicy)), 'request.effect.reconcile retryPolicy is invalid');
      return errors;
    },
  });

  function define(scope, mode, operation, retryPolicy, reconcile, validate = validators.none, options = {}) {
    return Object.freeze({
      scope,
      mode,
      operation,
      retryPolicy,
      reconcile,
      allowDuringLease: options.allowDuringLease === true,
      validate,
    });
  }

  const definitions = Object.freeze({
    'prompt.send': define(CommandScope.REQUEST, CommandMode.EFFECT, CommandOperation.WRITE, 'never', 'submitted_turn', validators.promptSend),
    'prompt.steer': define(CommandScope.REQUEST, CommandMode.EFFECT, CommandOperation.WRITE, 'never', 'submitted_turn', validators.promptSteer),
    'prompt.cancel': define(CommandScope.REQUEST, CommandMode.EFFECT, CommandOperation.WRITE, 'if_unconfirmed', 'generation_state', validators.promptCancel),
    'request.release': define(CommandScope.REQUEST, CommandMode.RELEASE, CommandOperation.CONTROL, 'always', 'lease_cleanup'),
    'request.resume': define(CommandScope.REQUEST, CommandMode.RESULT, CommandOperation.READ, 'always', 'request_projection'),
    'request.effect.reconcile': define(CommandScope.REQUEST, CommandMode.RESULT, CommandOperation.READ, 'always', 'effect_evidence', validators.effectReconcile),
    'response.snapshot.request': define(CommandScope.REQUEST, CommandMode.RESULT, CommandOperation.READ, 'always', 'request_projection'),

    'command.cancel': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.CONTROL, 'if_unconfirmed', 'target_command', validators.commandCancel, { allowDuringLease: true }),
    'passive.prompt.submit': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'never', 'submitted_turn', validators.passivePrompt),
    'sessions.list': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.READ, 'always', 'current_sessions', validators.none, { allowDuringLease: true }),
    'sessions.new': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'never', 'conversation_identity'),
    'sessions.select': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'conversation_identity', validators.sessionSelect),
    'sessions.delete': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'conversation_changed', validators.sessionDelete),
    'browser.tab.open': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'tab_identity'),
    'browser.tab.close': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'tab_absent'),
    'browser.tab.close-owned': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'tab_absent'),
    'browser.tab.reload': define(CommandScope.EITHER, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'content_epoch'),
    'debug.layout.capture': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.READ, 'always', 'none', validators.none, { allowDuringLease: true }),
    'extension.reload': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.MAINTENANCE, 'never', 'background_epoch'),
    'artifact.fetch': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'download_capture', validators.artifactFetch),
    'response.recover.latest': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.READ, 'always', 'current_turns', validators.none, { allowDuringLease: true }),
    'response.recover.list': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.READ, 'always', 'current_turns', validators.none, { allowDuringLease: true }),
    'response.recover.turnKey': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.READ, 'always', 'current_turns', validators.recoverTurn, { allowDuringLease: true }),
    'models.list': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.READ, 'always', 'current_selection', validators.none, { allowDuringLease: true }),
    'efforts.list': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.READ, 'always', 'current_selection', validators.none, { allowDuringLease: true }),
    'intelligence.apply': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'current_selection', validators.intelligence),
    'composer.attachments.clear': define(CommandScope.STANDALONE, CommandMode.RESULT, CommandOperation.WRITE, 'if_unconfirmed', 'composer_attachments'),
  });

  function commandDefinition(type = '') { return definitions[text(type)] || null; }
  function commandTypes() { return Object.freeze(Object.keys(definitions)); }
  function validateCommandPayload(type, payload = {}, options = {}) {
    const errors = [];
    const normalizedType = text(type || payload?.type);
    const definition = commandDefinition(normalizedType);
    if (!definition) return Object.freeze({ valid: false, errors: Object.freeze([`unsupported command type: ${normalizedType || 'missing'}`]), definition: null });
    if (!object(payload)) errors.push(`${normalizedType} payload must be an object`);
    if (text(payload?.type) && text(payload.type) !== normalizedType) errors.push(`${normalizedType} payload.type mismatch`);
    const scope = options.requestScoped === true ? CommandScope.REQUEST : CommandScope.STANDALONE;
    if (definition.scope !== CommandScope.EITHER && definition.scope !== scope) errors.push(`${normalizedType} requires ${definition.scope} scope`);
    for (const validationError of definition.validate(payload || {})) errors.push(validationError);
    return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), definition });
  }

  const api = Object.freeze({
    CommandMode,
    CommandOperation,
    CommandScope,
    definitions,
    commandDefinition,
    commandTypes,
    validateCommandPayload,
  });
  globalThis.ChatGptBridgeCommandManifest = api;
})();
