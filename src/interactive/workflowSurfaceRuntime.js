import { PromptEditor } from './terlioPromptEditor.js';
import { applyTerlioEditorKey } from './terlioInput.js';
import { resetTranscriptScroll, scrollTranscript } from './terlioScroll.js';
import { WorkflowSurfaceController } from './workflowSurfaceController.js';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function focusedAction(snapshot) {
  return snapshot.surface?.actions?.find(
    (action) => action.id === snapshot.navigation.focusActionId,
  ) || null;
}

function firstSectionValue(surface, names) {
  for (const section of surface?.sections || []) {
    for (const name of names) {
      if (section?.[name]) return section[name];
    }
    const item = section?.files?.[0] || section?.conflicts?.[0] || section?.choices?.[0];
    for (const name of names) {
      if (item?.[name]) return item[name];
    }
  }
  return '';
}

function defaultActionInput(action, surface, backendSnapshot) {
  if (!action?.inputSchema) return {};
  if (action.id === 'save-workflow') {
    return {
      workflow: clone(
        backendSnapshot?.workflow
        || backendSnapshot?.suggestedWorkflow
        || {},
      ),
    };
  }
  if (action.id === 'select-archive-root') {
    return { rootId: firstSectionValue(surface, ['rootId', 'id']) };
  }
  if (action.id === 'commit') {
    return { message: firstSectionValue(surface, ['suggestedMessage', 'message']) };
  }
  if (action.id === 'resolve-conflict') {
    return { path: firstSectionValue(surface, ['path']), decision: 'archive' };
  }
  if (action.inputSchema?.properties?.path) {
    return { path: firstSectionValue(surface, ['path']) };
  }
  return {};
}

function parseActionInput(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim() || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Action input must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw Object.assign(new Error(`Invalid action input JSON: ${error.message}`), {
      code: 'ACTION_INPUT_INVALID',
    });
  }
}

export class InteractiveWorkflowSurfaceRuntime {
  constructor(runtime, backend) {
    this.runtime = runtime;
    this.backend = backend;
    this.input = {
      opened: false,
      actionId: '',
      editor: new PromptEditor(),
    };
    this.scroll = resetTranscriptScroll();
    this.controller = new WorkflowSurfaceController({
      dispatchAction: (request) => this.backend.performAction(request),
      refreshSurface: async () => (await this.backend.refresh()).surface,
      onChange: () => this.runtime.invalidate(),
    });
    this.unsubscribe = backend?.subscribe?.((snapshot) => {
      if (!this.controller.opened || !snapshot.surface) return;
      this.controller.replaceSurface(snapshot.surface);
    }) || (() => {});
  }

  model() {
    const snapshot = this.controller.snapshot();
    return {
      ...snapshot,
      input: {
        opened: this.input.opened,
        actionId: this.input.actionId,
        editor: this.input.editor,
      },
      scroll: this.scroll,
      backend: this.backend?.snapshot?.() || null,
    };
  }

  async open({ projectPath = '', workflowId = '' } = {}) {
    const target = projectPath
      || this.runtime.state.projectRoot
      || this.runtime.options.projectPath
      || process.cwd();
    const snapshot = await this.backend.openProject(target, { workflowId });
    if (!snapshot.surface) {
      throw Object.assign(new Error('Workflow service returned no semantic surface'), {
        code: 'WORKFLOW_SURFACE_MISSING',
      });
    }
    this.scroll = resetTranscriptScroll();
    return this.controller.open(snapshot.surface, {
      returnView: {
        transcript: clone(this.runtime.transcriptScroll),
        detailsOpen: this.runtime.detailsOpen,
      },
    });
  }

  close() {
    this.#closeInput();
    this.controller.close();
    this.scroll = resetTranscriptScroll();
    this.runtime.invalidate();
  }

  async activate() {
    const snapshot = this.controller.snapshot();
    const action = focusedAction(snapshot);
    if (!action) return;
    if (action.inputSchema && !this.input.opened) {
      const value = defaultActionInput(action, snapshot.surface, this.backend.snapshot());
      this.input.opened = true;
      this.input.actionId = action.id;
      this.input.editor.set(JSON.stringify(value, null, 2));
      return this.runtime.invalidate();
    }
    const input = action.inputSchema ? parseActionInput(this.input.editor.value) : {};
    if (!await this.#confirm(action)) return;
    const result = await this.controller.activate(action.id, input);
    this.#closeInput();
    if (result.stale) {
      this.runtime.pushEntry({
        kind: 'system',
        title: 'Workflow refreshed',
        body: 'The selected action changed on the server. Review the refreshed workflow before trying again.',
      });
    }
    this.runtime.invalidate();
  }

  async #confirm(action) {
    if (action.confirmation === 'none') return true;
    const accepted = await this.runtime.context.confirm(
      `${action.label} (${action.risk})? [y/N]`,
    );
    if (!accepted || action.confirmation !== 'dangerous') return accepted;
    return await this.runtime.context.confirm(
      `Confirm dangerous workflow action again: ${action.label}? [y/N]`,
    );
  }

  #closeInput() {
    this.input.opened = false;
    this.input.actionId = '';
    this.input.editor.clear();
  }

  async handleKey(key) {
    const keyText = key.text || (key.printable ? key.sequence : '');
    if (key.name === 'escape') {
      if (this.input.opened) {
        this.#closeInput();
        return this.runtime.invalidate();
      }
      return this.close();
    }
    if (key.name === 'page-up' || key.name === 'page-down') {
      this.scroll = scrollTranscript(this.scroll, key.name, { lineStep: 1 });
      return this.runtime.invalidate();
    }
    if (this.input.opened) {
      if (key.name === 'enter' && !key.shift && !key.ctrl) return await this.activate();
      if (key.name === 'enter') {
        this.input.editor.insertLineBreak();
        return this.runtime.invalidate();
      }
      const result = applyTerlioEditorKey(this.input.editor, key, { multiline: true });
      if (result.handled) this.runtime.invalidate();
      return;
    }
    if (key.name === 'up' || key.name === 'down') {
      this.controller.moveAction(key.name === 'up' ? -1 : 1);
      return;
    }
    if (key.name === 'enter') return await this.activate();
    if (/^[1-9]$/.test(keyText)) {
      this.controller.selectActionByIndex(Number(keyText) - 1);
      return this.runtime.invalidate();
    }
    if (key.name === 'redraw') return await this.open();
  }

  closeRuntime() {
    this.unsubscribe();
    this.unsubscribe = () => {};
  }
}
