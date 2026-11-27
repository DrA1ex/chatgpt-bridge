// The ChatGPT branch is the presentation source of truth. Local execution
// items are an overlay (reasoning, artifacts, delivery state), not a second
// independent transcript. Never mutate or discard stored local execution data.
const role = item => item.type === 'user_message' ? 'user' : item.type === 'agent_message' ? 'assistant' : '';
const text = item => String(item?.content?.text || '').replace(/\s+/g, ' ').trim();
const identity = value => String(value || '').replace(/^(user|assistant):/, '');
const native = value => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity(value));
const sourceId = item => identity(item?.content?.sourceMessageId);
const terminal = item => item?.status !== 'in_progress';

function withCanonical(local, remote) {
  return {
    ...local, status: remote.status,
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

function matchLocal(group, remoteGroups, used) {
  const user = group.find(item => role(item) === 'user');
  const answer = group.find(item => role(item) === 'assistant');
  if (!user) return -1;
  const userId = identity(answer?.content?.sourceUserMessageId || user.content?.sourceMessageId);
  const answerId = sourceId(answer);
  const available = remoteGroups.map((items, index) => ({ items, index })).filter(entry => !used.has(entry.index));
  const exact = available.filter(({ items }) => items.some(item =>
    (role(item) === 'user' && native(userId) && sourceId(item) === userId)
    || (role(item) === 'assistant' && native(answerId) && sourceId(item) === answerId)));
  if (exact.length === 1) return exact[0].index;
  if (exact.length > 1 || native(userId) || native(answerId)) return -1;
  // Old Bridge versions did not persist native IDs. Only use an unambiguous
  // prompt, or an unambiguous prompt+answer pair for repeated prompts.
  const candidates = available.filter(({ items }) => role(items[0]) === 'user' && text(items[0]) === text(user));
  if (candidates.length === 1) return candidates[0].index;
  const pairs = candidates.filter(({ items }) => answer && text(answer)
    && items.some(item => role(item) === 'assistant' && text(item) === text(answer)));
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
  if (existingUser && text(existingUser) === text({ content: user })) return imported;
  return [...imported, ...items];
}

export function mergeConversationItems(imported, local, live = [], canonical = true) {
  const threadId = imported[0]?.threadId || local[0]?.threadId || '';
  const remote = mergeLive(imported, live, threadId);
  if (!canonical) return [...remote, ...local].map((item, index) => ({ ...item, historyOrder: index }));
  const groups = groupByUser(remote);
  const used = new Set();
  const unmatched = [];
  for (const group of localGroups(local)) {
    const index = matchLocal(group, groups, used);
    if (index < 0) { unmatched.push(...group); continue; }
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
