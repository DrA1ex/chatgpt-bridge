const STALE_ACTION_CODES = new Set(['STALE_REVISION', 'ACTION_NOT_AVAILABLE']);
const DIFF_MODES = new Set(['unified', 'side-by-side']);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function text(value) {
  return String(value || '').trim();
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function surfaceError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function normalizeAction(action = {}) {
  const source = action && typeof action === 'object' ? action : {};
  return {
    ...clone(source),
    id: text(source.id),
    kind: text(source.kind),
    label: text(source.label),
    description: text(source.description),
    enabled: source.enabled !== false,
    disabledReason: text(source.disabledReason),
    risk: text(source.risk || 'read'),
    confirmation: text(source.confirmation || 'none'),
    inputSchema: source.inputSchema && typeof source.inputSchema === 'object'
      ? clone(source.inputSchema)
      : null,
  };
}

function normalizeSurface(surface = {}) {
  if (!surface || typeof surface !== 'object' || Array.isArray(surface)) {
    throw surfaceError('WORKFLOW_SURFACE_INVALID', 'Workflow surface must be an object');
  }
  const id = text(surface.id);
  const kind = text(surface.kind);
  if (!id || !kind) {
    throw surfaceError('WORKFLOW_SURFACE_INVALID', 'Workflow surface requires id and kind');
  }
  return {
    ...clone(surface),
    id,
    kind,
    revision: nonNegativeInteger(surface.revision),
    title: text(surface.title),
    summary: text(surface.summary),
    sections: Array.isArray(surface.sections) ? clone(surface.sections) : [],
    actions: Array.isArray(surface.actions) ? surface.actions.map(normalizeAction).filter((action) => action.id) : [],
    links: surface.links && typeof surface.links === 'object' ? clone(surface.links) : {},
  };
}

function emptyNavigationState() {
  return {
    focusActionId: '',
    focusSectionId: '',
    scroll: 0,
    search: '',
    editorValues: {},
    selectedPath: '',
    diffMode: 'unified',
  };
}

function inputTypeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

export function validateWorkflowActionInput(schema, input = {}) {
  if (!schema) return [];
  const value = input == null ? {} : input;
  const errors = [];
  if (schema.type && !inputTypeMatches(value, schema.type)) {
    return [`input must be ${schema.type}`];
  }
  if (schema.type !== 'object' && !schema.properties && !schema.required) return errors;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['input must be object'];
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (!(name in value) || value[name] === '') errors.push(`${name} is required`);
  }
  for (const [name, property] of Object.entries(schema.properties || {})) {
    if (!(name in value) || !property || typeof property !== 'object') continue;
    if (property.type && !inputTypeMatches(value[name], property.type)) {
      errors.push(`${name} must be ${property.type}`);
    }
    if (Array.isArray(property.enum) && !property.enum.includes(value[name])) {
      errors.push(`${name} must be one of the advertised values`);
    }
  }
  return errors;
}

export class WorkflowSurfaceController {
  constructor({
    dispatchAction = null,
    refreshSurface = null,
    onChange = () => {},
  } = {}) {
    this.dispatchAction = dispatchAction;
    this.refreshSurface = refreshSurface;
    this.onChange = onChange;
    this.opened = false;
    this.busy = false;
    this.surface = null;
    this.navigation = emptyNavigationState();
    this.navigationBySurface = new Map();
    this.returnView = null;
    this.lastError = null;
  }

  snapshot() {
    return {
      opened: this.opened,
      busy: this.busy,
      surface: clone(this.surface),
      navigation: clone(this.navigation),
      returnView: clone(this.returnView),
      lastError: this.lastError
        ? { code: text(this.lastError.code), message: text(this.lastError.message) }
        : null,
    };
  }

  #emit() {
    try {
      this.onChange(this.snapshot());
    } catch {
      // Rendering invalidation cannot own workflow state.
    }
  }

  #saveNavigation() {
    if (!this.surface?.id) return;
    this.navigationBySurface.set(this.surface.id, clone(this.navigation));
    while (this.navigationBySurface.size > 50) {
      this.navigationBySurface.delete(this.navigationBySurface.keys().next().value);
    }
  }

  #ensureFocus() {
    const actions = this.surface?.actions || [];
    if (actions.some((action) => action.id === this.navigation.focusActionId && action.enabled)) return;
    this.navigation.focusActionId = actions.find((action) => action.enabled)?.id || actions[0]?.id || '';
  }

  open(surface, { returnView = undefined } = {}) {
    const normalized = normalizeSurface(surface);
    this.#saveNavigation();
    if (!this.opened && returnView !== undefined) this.returnView = clone(returnView);
    this.surface = normalized;
    this.navigation = clone(this.navigationBySurface.get(normalized.id) || emptyNavigationState());
    this.#ensureFocus();
    this.opened = true;
    this.lastError = null;
    this.#emit();
    return this.snapshot();
  }

  replaceSurface(surface) {
    const normalized = normalizeSurface(surface);
    const sameSurface = this.surface?.id === normalized.id;
    this.#saveNavigation();
    this.surface = normalized;
    this.navigation = sameSurface
      ? this.navigation
      : clone(this.navigationBySurface.get(normalized.id) || emptyNavigationState());
    this.#ensureFocus();
    this.#emit();
    return this.snapshot();
  }

  close() {
    this.#saveNavigation();
    this.opened = false;
    this.busy = false;
    const result = { returnView: clone(this.returnView), surface: clone(this.surface) };
    this.#emit();
    return result;
  }

  setScroll(value) {
    this.navigation.scroll = nonNegativeInteger(value);
    this.#emit();
  }

  setSearch(value) {
    this.navigation.search = String(value || '');
    this.#emit();
  }

  focusSection(sectionId) {
    this.navigation.focusSectionId = text(sectionId);
    this.#emit();
  }

  setEditorValue(key, value) {
    const id = text(key);
    if (!id) return;
    this.navigation.editorValues[id] = String(value ?? '');
    this.#emit();
  }

  setSelectedPath(value) {
    this.navigation.selectedPath = String(value || '');
    this.#emit();
  }

  setDiffMode(value) {
    const mode = text(value);
    if (!DIFF_MODES.has(mode)) throw surfaceError('WORKFLOW_DIFF_MODE_INVALID', `Unknown diff mode: ${mode}`);
    this.navigation.diffMode = mode;
    this.#emit();
  }

  focusAction(actionId) {
    const id = text(actionId);
    if (!this.surface?.actions.some((action) => action.id === id)) {
      throw surfaceError('WORKFLOW_ACTION_UNKNOWN', `Unknown workflow action: ${id}`);
    }
    this.navigation.focusActionId = id;
    this.#emit();
  }

  selectActionByIndex(index) {
    const actions = this.surface?.actions || [];
    const action = actions[Math.max(0, Math.min(actions.length - 1, Number(index) || 0))];
    if (!action) throw surfaceError('WORKFLOW_ACTION_UNKNOWN', 'This workflow surface has no actions');
    this.focusAction(action.id);
    return clone(action);
  }

  moveAction(delta) {
    const actions = (this.surface?.actions || []).filter((action) => action.enabled);
    if (!actions.length) return null;
    const current = Math.max(0, actions.findIndex((action) => action.id === this.navigation.focusActionId));
    const next = Math.max(0, Math.min(actions.length - 1, current + Number(delta || 0)));
    this.focusAction(actions[next].id);
    return clone(actions[next]);
  }

  async refresh(reason = 'manual') {
    if (typeof this.refreshSurface !== 'function') {
      throw surfaceError('WORKFLOW_SURFACE_REFRESH_UNAVAILABLE', 'Workflow surface refresh is unavailable');
    }
    const refreshed = await this.refreshSurface({
      surface: clone(this.surface),
      reason,
    });
    this.replaceSurface(refreshed);
    return clone(this.surface);
  }

  async activate(actionReference = '', input = {}) {
    if (!this.surface) throw surfaceError('WORKFLOW_SURFACE_CLOSED', 'No workflow surface is open');
    const action = typeof actionReference === 'number'
      ? this.selectActionByIndex(actionReference)
      : this.surface.actions.find((item) => item.id === text(actionReference || this.navigation.focusActionId));
    if (!action) throw surfaceError('WORKFLOW_ACTION_UNKNOWN', 'The selected workflow action is no longer available');
    if (!action.enabled) {
      throw surfaceError(
        'WORKFLOW_ACTION_DISABLED',
        action.disabledReason || `Workflow action ${action.id} is disabled`,
      );
    }
    const inputErrors = validateWorkflowActionInput(action.inputSchema, input);
    if (inputErrors.length) {
      throw surfaceError('ACTION_INPUT_INVALID', inputErrors.join('; '), { errors: inputErrors });
    }
    if (typeof this.dispatchAction !== 'function') {
      throw surfaceError('WORKFLOW_ACTION_DISPATCH_UNAVAILABLE', 'Workflow action dispatch is unavailable');
    }

    this.busy = true;
    this.lastError = null;
    this.#emit();
    try {
      const result = await this.dispatchAction({
        actionId: action.id,
        actionKind: action.kind,
        input: clone(input),
        surfaceId: this.surface.id,
        surfaceRevision: this.surface.revision,
        links: clone(this.surface.links),
      });
      if (result?.surface) this.replaceSurface(result.surface);
      return { ok: true, stale: false, actionId: action.id, result };
    } catch (error) {
      this.lastError = error;
      if (STALE_ACTION_CODES.has(text(error?.code)) && typeof this.refreshSurface === 'function') {
        const surface = await this.refresh('stale_action');
        this.lastError = null;
        return { ok: false, stale: true, actionId: action.id, surface };
      }
      throw error;
    } finally {
      this.busy = false;
      this.#emit();
    }
  }
}
