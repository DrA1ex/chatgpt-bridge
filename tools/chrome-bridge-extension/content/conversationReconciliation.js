(() => {
  'use strict';

  const text = (value) => typeof value === 'string' ? value : '';
  function result(expected, status, reason, extra = {}) {
    return { source: 'conversation-record', version: 1, status, reason,
      conversationId: text(expected?.conversationId), userMessageId: text(expected?.userMessageId),
      assistantMessageId: text(expected?.assistantMessageId), ...extra };
  }

  // Internal endpoint schemas are not authoritative lifecycle contracts. Only
  // exact message IDs on the selected branch can yield positive evidence.
  function reconcile(record, expected, observedAnswer) {
    const unknown = (reason) => result(expected, 'unavailable', reason);
    const mismatch = (reason) => result(expected, 'mismatch', reason);
    if (!expected.conversationId || !expected.userMessageId || !expected.assistantMessageId) return unknown('missing_identity');
    if (!record || !record.mapping || typeof record.mapping !== 'object' || Array.isArray(record.mapping)
      || !text(record.current_node) || !text(record.conversation_id)) return unknown('unsupported_record');
    if (record.conversation_id !== expected.conversationId) return mismatch('conversation_identity');
    const branch = [];
    const seen = new Set();
    const messageIds = new Set();
    let key = record.current_node;
    while (key != null) {
      if (seen.has(key) || branch.length >= 10000) return unknown('invalid_branch');
      seen.add(key);
      const node = record.mapping[key];
      if (!node || !Object.hasOwn(node, 'parent') || (node.parent !== null && typeof node.parent !== 'string')) return unknown('invalid_branch');
      if (node.message?.id) {
        if (messageIds.has(node.message.id)) return unknown('invalid_branch');
        messageIds.add(node.message.id);
      }
      branch.push(node);
      key = node.parent;
    }
    const index = branch.findIndex((node) => node.message?.id === expected.assistantMessageId);
    if (index < 0) return mismatch('assistant_not_on_current_branch');
    const message = branch[index].message;
    if (message.author?.role !== 'assistant') return mismatch('assistant_role');
    const parentUser = branch.slice(index + 1).find((node) => node.message?.author?.role === 'user');
    if (parentUser?.message?.id !== expected.userMessageId) return mismatch('user_boundary');
    // A later assistant message can supersede a finished earlier message.
    if (branch.slice(0, index).some((node) => ['user', 'assistant'].includes(node.message?.author?.role))) return mismatch('superseded_message');
    if (!['finished_successfully', 'in_progress', 'finished_partial', 'finished_error', 'cancelled'].includes(message.status)
      || typeof message.end_turn !== 'boolean') return unknown('unsupported_completion');
    const complete = message.status === 'finished_successfully' && message.end_turn === true
      && (!message.recipient || message.recipient === 'all') && (!message.channel || message.channel === 'final');
    const parts = message.content?.content_type === 'text' && Array.isArray(message.content.parts)
      && message.content.parts.every((part) => typeof part === 'string') ? message.content.parts : null;
    return result(expected, complete ? 'matched_complete' : 'matched_incomplete', 'exact_branch_boundary', {
      backendStatus: message.status, endTurn: message.end_turn,
      textMatches: parts && typeof observedAnswer === 'string' ? parts.join('') === observedAnswer : null,
    });
  }

  async function read(expected, observedAnswer, deps = {}) {
    const unavailable = (reason) => result(expected, 'unavailable', reason);
    if (!expected?.conversationId || !expected?.userMessageId || !expected?.assistantMessageId) return unavailable('missing_identity');
    const page = new URL(deps.url || location.href);
    if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(page.origin)) return unavailable('unsupported_origin');
    const conversation = page.pathname.match(/\/c\/([^/]+)/)?.[1];
    if (conversation !== expected.conversationId) return unavailable('page_conversation_changed');
    const fetchImpl = deps.fetch || globalThis.fetch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    deps.signal?.addEventListener('abort', abort, { once: true });
    if (deps.signal?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), 4000);
    const options = { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal };
    try {
      const url = `${page.origin}/backend-api/conversation/${encodeURIComponent(expected.conversationId)}`;
      let response = await fetchImpl(url, options);
      if (response.status === 401) {
        // Keep the token inside this read only; never return, persist or log it.
        const session = await fetchImpl(`${page.origin}/api/auth/session`, options);
        if (!session.ok) return unavailable('authentication_unavailable');
        const token = text((await session.json())?.accessToken);
        if (!token) return unavailable('authentication_unavailable');
        response = await fetchImpl(url, { ...options, headers: { Authorization: `Bearer ${token}` } });
      }
      if (!response.ok) return unavailable(`http_${response.status}`);
      const record = await response.json();
      if (!deps.url && location.href !== page.href) return unavailable('page_conversation_changed');
      return { ...reconcile(record, expected, observedAnswer), checkedAt: Date.now() };
    } catch {
      return unavailable(controller.signal.aborted ? 'timeout' : 'record_unavailable');
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', abort);
    }
  }

  globalThis.ChatGptConversationReconciliation = Object.freeze({ reconcile, read });
})();
