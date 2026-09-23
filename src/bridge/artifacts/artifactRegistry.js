import { makeEvent } from '../requestState.js';
import { isImageArtifact } from '../../results/artifactImage.js';

/** Owns durable image readiness, independently of request completion. */
export class ArtifactRegistry extends Map {
  #captures = new Map();
  #results = new Map();
  #capture;
  #onSettled;

  constructor({ capture, onSettled = () => {} }) {
    super();
    this.#capture = capture;
    this.#onSettled = onSettled;
  }

  set(id, artifact) {
    if (!isImageArtifact(artifact)) return super.set(id, artifact);
    const result = this.#results.get(id);
    if (result) {
      Object.assign(artifact, result);
      return super.set(id, artifact);
    }
    const phase = String(artifact.phase || 'READY').toUpperCase();
    if (!this.#captures.has(id) && phase !== 'READY') return super.set(id, artifact);
    // Mutate the publication projection too: observers must never see READY
    // merely because the DOM image has finished loading.
    Object.assign(artifact, { phase: 'MATERIALIZING', downloadable: false });
    super.set(id, artifact);
    if (!this.#captures.has(id)) {
      const pending = Promise.resolve().then(() => this.#capture(id)).then((stored) => {
        if (stored?.kind !== 'artifact' || stored?.contentBase64 || !stored?.id || !stored?.size || !String(stored.mime).startsWith('image/')) {
          throw Object.assign(new Error('Image was not durably stored'), { code: 'ARTIFACT_MATERIALIZATION_FAILED' });
        }
        return { phase: 'READY', downloadable: true, storedFileId: stored.id,
          kind: 'image', name: stored.name, mime: stored.mime, size: stored.size };
      }).catch((error) => ({ phase: 'FAILED', downloadable: false,
        materializationError: { code: error.code || 'ARTIFACT_MATERIALIZATION_FAILED',
          message: 'Generated image materialization failed' } }))
        .then((settled) => {
          this.#results.set(id, settled);
          Object.assign(artifact, settled);
          const current = this.get(id);
          if (current) Object.assign(current, settled);
          this.#captures.delete(id);
          // Consumer callbacks cannot turn a durable capture into a failure.
          try { this.#onSettled(current || artifact); } catch {}
        });
      this.#captures.set(id, pending);
    }
    return this;
  }

  async settled(artifacts = []) {
    await Promise.all(artifacts.map((artifact) => this.#captures.get(artifact.id)));
    return artifacts.map((artifact) => ({ ...artifact, ...(this.#results.get(artifact.id) || {}) }));
  }

  delete(id) {
    this.#results.delete(id);
    return super.delete(id);
  }
}

export function publishArtifactSettlement(artifact, { pending, lifecycle, eventBus }) {
  const state = pending.get(artifact.requestId);
  if (state && !state.done) {
    state.artifacts = state.artifacts.map((item) => item.id === artifact.id ? { ...item, ...artifact } : item);
    state.callbacks.onArtifactUpdate?.(state.artifacts, { type: 'artifact.snapshot' });
    lifecycle.emitRequestEvent(state, makeEvent('artifact.snapshot', { artifacts: state.artifacts }), { canonical: false });
  }
  eventBus?.emitUser({ type: 'artifact.materialization.settled', data: {
    artifactId: artifact.id, phase: artifact.phase, mime: artifact.mime, size: artifact.size || 0,
    code: artifact.materializationError?.code || '',
  } });
}
