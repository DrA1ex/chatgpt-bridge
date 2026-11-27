// The ChatGPT branch is the presentation source of truth. Local execution
// items are an overlay (reasoning, artifacts, delivery state), not a second
// independent transcript. Never mutate or discard stored local execution data.
const role = item => item.type === 'user_message' ? 'user' : item.type === 'agent_message' ? 'assistant' : '';
const text = item => String(item?.content?.text || '').replace(/\s+/g, ' ').trim();
const identity = value => String(value || '').replace(/^(user|assistant):/, '');
const native = value => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity(value));
const sourceId = item => identity(item?.content?.sourceMessageId);
const terminal = item => item?.status !== 'in_progress';
const FAILED = new Set(['failed', 'cancelled', 'interrupted']);
const TERMINAL = new Set(['completed', 'completed_without_artifact', ...FAILED]);

export const canResolveUnsent = item => item?.type === 'user_message'
  && ['not_sent', 'unconfirmed'].includes(item.delivery?.state);

// A local user item is created before the prompt is submitted. The actual
// browser effect result, not the item's storage status, proves delivery.
export async function annotateLocalDelivery(items, turns, readEvents) {
  const turnById = new Map(turns.map(turn => [turn.id, turn]));
  const annotations = new Map();
  for (const user of items.filter(item => role(item) === 'user')) {
    const turn = turnById.get(user.turnId);
    if (!turn) continue;
    if (!TERMINAL.has(turn.status)) {
      annotations.set(user.id, { state: 'pending' });
      continue;
    }
    if (!FAILED.has(turn.status)) continue;
    const events = await readEvents(turn.id);
    const submissions = events.filter(event => event.type === 'request.effect.succeeded'
      && event.data?.effectType === 'prompt.submit');
    const key = submissions.map(event => event.data?.result?.submittedUserTurnKey).filter(Boolean).at(-1)
      || events.filter(event => ['prompt.sent', 'prompt.submitted', 'request.retry.accepted'].includes(event.type))
        .map(event => event.data?.submittedUserTurnKey).filter(Boolean).at(-1) || '';
    const accepted = submissions.length > 0 || events.some(event => ['prompt.sent', 'prompt.submitted', 'request.retry.accepted'].includes(event.type));
    const state = accepted ? 'confirmed' : !turn.startedAt ? 'not_sent' : 'unconfirmed';
    annotations.set(user.id, { state, sourceMessageId: key, reason: turn.error?.message || turn.status });
  }
  return items.map(item => {
    const delivery = annotations.get(item.id);
    if (!delivery) return item;
    return {
      ...item, delivery,
      content: { ...item.content, ...(delivery.sourceMessageId ? { sourceMessageId: delivery.sourceMessageId } : {}) },
    };
  });
}

function withCanonical(local, remote) {
  return {
    ...local, status: remote.status,
    ...(role(local) === 'user' ? { delivery: { state: 'confirmed' } } : {}),
    content: { ...local.content, text: remote.content.text, sourceMessageId: remote.content.sourceMessageId, historyCanonical: true },
  };
}

function groupByUser(items) {
  const groups = [];
  for (const item of items) {
    if (role(item) === 'user' || !groups.length) groups.push([]);
    groups.at(-1).push(item);
  }
  return groups;
}

function localGroups(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.turnId)) groups.set(item.turnId, []);
    groups.get(item.turnId).push(item);
  }
  return [...groups.values()];
}

function matchLocal(group, remoteGroups, exactOnly = false) {
  const user = group.find(item => role(item) === 'user');
  const answer = group.find(item => role(item) === 'assistant');
  if (!user || user.delivery?.state === 'not_sent') return -1;
  const userId = identity(answer?.content?.sourceUserMessageId || user.content?.sourceMessageId);
  const answerId = sourceId(answer);
  const candidates = remoteGroups.map((items, index) => ({ items, index }));
  const exact = candidates.filter(({ items }) => items.some(item =>
    (role(item) === 'user' && native(userId) && sourceId(item) === userId)
    || (role(item) === 'assistant' && native(answerId) && sourceId(item) === answerId)));
  if (exact.length === 1) return exact[0].index;
  if (exactOnly || exact.length > 1 || native(userId) || native(answerId)) return -1;
  // Evaluate ambiguity against the entire branch, never just the remaining
  // unmatched groups. Consuming one repeated prompt does not prove another.
  const prompts = candidates.filter(({ items }) => role(items[0]) === 'user' && text(items[0]) === text(user));
  if (prompts.length === 1 && !user.delivery) return prompts[0].index;
  const pairs = prompts.filter(({ items }) => answer && text(answer) && answer.status === 'completed'
    && items.some(item => role(item) === 'assistant' && terminal(item) && text(item) === text(answer)));
  return pairs.length === 1 ? pairs[0].index : -1;
}

function mergeLive(imported, messages, threadId) {
  if (!messages.length) return imported;
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  if (lastUser < 0) return imported;
  const tail = messages.slice(lastUser);
  const user = tail[0];
  const lastImportedUser = imported.findLastIndex(item => role(item) === 'user');
  const existingUser = imported[lastImportedUser];
  const same = existingUser && (sourceId(existingUser) === identity(user.id)
    || (!native(sourceId(existingUser)) || !native(user.id)) && text(existingUser) === text({ content: user }));
  const items = tail.map(message => ({
    id: `${threadId}:import:${message.id}`, threadId, turnId: `${threadId}:import:${message.id}`,
    type: message.role === 'user' ? 'user_message' : 'agent_message',
    status: message.role === 'assistant' ? 'in_progress' : 'completed',
    content: { text: message.text, imported: true, sourceMessageId: message.id },
  }));
  // The live snapshot owns only the tail, not previous completed messages.
  // Never replace a completed canonical answer with a progress fragment.
  if (same) {
    const completedAnswer = imported.slice(lastImportedUser + 1).some(item => role(item) === 'assistant' && terminal(item));
    if (completedAnswer) return imported;
    return [...imported.slice(0, lastImportedUser + 1), ...items.slice(1)];
  }
  // Identical Loop text is normal. Distinct native IDs prove that this is
  // a new prompt, not a stale snapshot of the last completed one.
  if (native(user.id) && imported.some(item => role(item) === 'user' && sourceId(item) === identity(user.id))) return imported;
  if (existingUser && text(existingUser) === text({ content: user })
    && (!native(sourceId(existingUser)) || !native(user.id))) return imported;
  return [...imported, ...items];
}

function visibleUnmatchedGroup(group) {
  const user = group.find(item => role(item) === 'user');
  // Dismiss only the unsuccessful local attempt, never its stored data
  // or artifacts. A later canonical identity still takes precedence.
  return user?.content?.historyDismissed ? group.filter(item => item.type === 'artifact') : group;
}

export function mergeConversationItems(imported, local, live = [], canonical = true) {
  const threadId = imported[0]?.threadId || local[0]?.threadId || '';
  const remote = mergeLive(imported, live, threadId);
  if (!canonical) return [...remote, ...localGroups(local).flatMap(visibleUnmatchedGroup)].map((item, index) => ({ ...item, historyOrder: index }));
  const groups = groupByUser(remote);
  const used = new Set();
  const unmatched = [];
  const locals = localGroups(local);
  // Reserve exact native matches before considering text-only legacy items.
  // Compute matches against the immutable remote groups, before overlaying.
  const exact = locals.map(group => matchLocal(group, groups, true));
  const proposed = locals.map((group, i) => exact[i] >= 0 ? exact[i] : matchLocal(group, groups));
  const exactClaims = new Set(exact.filter(index => index >= 0));
  const counts = new Map();
  for (let i = 0; i < proposed.length; i++) {
    const index = proposed[i];
    if (index >= 0 && (exact[i] >= 0 || !exactClaims.has(index))) {
      counts.set(index, (counts.get(index) || 0) + 1);
    }
  }
  for (let i = 0; i < locals.length; i++) {
    const group = locals[i];
    const index = proposed[i];
    if (index < 0 || used.has(index) || counts.get(index) !== 1
      || (exact[i] < 0 && exactClaims.has(index))) {
      unmatched.push(...visibleUnmatchedGroup(group));
      continue;
    }
    used.add(index);
    const messages = groups[index];
    const user = group.find(item => role(item) === 'user');
    const answer = group.find(item => role(item) === 'assistant');
    const remoteUser = messages.find(item => role(item) === 'user');
    const remoteAnswers = messages.filter(item => role(item) === 'assistant');
    const extra = group.filter(item => !role(item));
    const renderedAnswers = remoteAnswers.map((item, i) => answer && i === remoteAnswers.length - 1
      ? (item.status === 'in_progress' && answer.status === 'in_progress' ? answer : withCanonical(answer, item)) : item);
    groups[index] = [
      ...(remoteUser ? [user ? withCanonical(user, remoteUser) : remoteUser] : []),
      ...extra.filter(item => item.type === 'reasoning'),
      ...renderedAnswers,
      // API can lag an active/local response; keep only genuinely local
      // output while no authoritative answer has appeared.
      ...(!remoteAnswers.length && answer ? [answer] : []),
      ...extra.filter(item => item.type !== 'reasoning'),
    ];
  }
  return [...groups.flat(), ...unmatched].map((item, index) => ({ ...item, historyOrder: index }));
}
