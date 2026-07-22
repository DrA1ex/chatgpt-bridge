import {
  BACKGROUND_STATE_SCHEMA_VERSION,
  createTabRuntimeState,
  rejected,
} from './stateV6Core.js';
import { reduceLeaseEvent } from './stateV6LeaseReducer.js';
import { reduceCommandEvent } from './stateV6CommandReducer.js';
import { reduceEffectEvent } from './stateV6EffectReducer.js';
import { reduceTransportEvent } from './stateV6TransportReducer.js';
import { reduceDownloadEvent } from './stateV6DownloadReducer.js';

const DOMAIN_REDUCERS = Object.freeze([
  reduceLeaseEvent,
  reduceCommandEvent,
  reduceEffectEvent,
  reduceTransportEvent,
  reduceDownloadEvent,
]);

export function reduceTabRuntimeState(state, event) {
  if (!state || state.schemaVersion !== BACKGROUND_STATE_SCHEMA_VERSION) return rejected(createTabRuntimeState(event?.tabId), event, 'invalid_state');
  if (!event || typeof event.type !== 'string') return rejected(state, event, 'invalid_event');
  if (event.tabId != null && event.tabId !== state.tabId) return rejected(state, event, 'tab_mismatch');
  if (event.backgroundEpoch && event.backgroundEpoch !== state.backgroundEpoch) return rejected(state, event, 'background_epoch_mismatch');
  if (event.contentEpoch && state.contentEpoch && event.contentEpoch !== state.contentEpoch && event.type !== 'content.attached') {
    return rejected(state, event, 'content_epoch_mismatch');
  }
  for (const reduceDomainEvent of DOMAIN_REDUCERS) {
    const outcome = reduceDomainEvent(state, event);
    if (outcome) return outcome;
  }
  return rejected(state, event, 'unknown_event');
}
