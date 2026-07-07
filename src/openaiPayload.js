export function normalizeContent(content) {
  if (content == null) return '';

  if (typeof content === 'string') return content.trim();

  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') {
        const text = item.trim();
        if (text) parts.push(text);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text' && typeof item.text === 'string') {
        const text = item.text.trim();
        if (text) parts.push(text);
      } else if (typeof item.content === 'string') {
        const text = item.content.trim();
        if (text) parts.push(text);
      }
    }
    return parts.join('\n').trim();
  }

  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text.trim();
    if (typeof content.content === 'string') return content.content.trim();
  }

  return String(content).trim();
}

export function extractAttachmentsFromContent(content) {
  if (!Array.isArray(content)) return [];
  const attachments = [];

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'file' || item.type === 'input_file') {
      attachments.push({
        fileId: item.file_id || item.fileId || item.id,
        name: item.filename || item.name,
        mime: item.mime || item.mime_type,
        contentBase64: item.contentBase64 || item.content_base64,
      });
    }

    if (item.type === 'image_url' && item.image_url) {
      const url = typeof item.image_url === 'string' ? item.image_url : item.image_url.url;
      if (url && url.startsWith('data:')) {
        const match = url.match(/^data:([^;,]+)?;base64,(.+)$/);
        if (match) {
          attachments.push({
            name: item.name || 'image',
            mime: match[1] || 'image/png',
            contentBase64: match[2],
          });
        }
      } else if (url) {
        attachments.push({ type: 'image_url', url, name: item.name || 'image' });
      }
    }
  }

  return attachments.filter((attachment) => attachment.fileId || attachment.contentBase64 || attachment.url);
}

export function extractLastUserMessageFromPayload(payload) {
  return extractRequestFromOpenAIPayload(payload).message;
}

export function extractRequestFromOpenAIPayload(payload) {
  const result = {
    message: '',
    attachments: [],
    model: typeof payload?.model === 'string' ? payload.model : '',
    effort: typeof payload?.effort === 'string'
      ? payload.effort
      : typeof payload?.reasoning_effort === 'string'
        ? payload.reasoning_effort
        : typeof payload?.reasoning?.effort === 'string'
          ? payload.reasoning.effort
          : '',
    sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : typeof payload?.conversation_id === 'string' ? payload.conversation_id : '',
    newSession: Boolean(payload?.newSession || payload?.new_conversation),
  };

  const messages = payload?.messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || typeof message !== 'object') continue;
      if (message.role !== 'user') continue;

      result.message = normalizeContent(message.content);
      result.attachments.push(...extractAttachmentsFromContent(message.content));
      break;
    }
  }

  if (!result.message) {
    result.message = normalizeContent(payload?.input) || normalizeContent(payload?.prompt);
  }

  if (Array.isArray(payload?.attachments)) result.attachments.push(...payload.attachments);
  if (Array.isArray(payload?.fileIds)) result.attachments.push(...payload.fileIds);

  return result;
}

export function makeOpenAIChatCompletionResponse(response) {
  const content = typeof response === 'string' ? response : response?.answer || response?.response || '';
  const extra = typeof response === 'object' && response ? response : {};
  return {
    id: extra.id || 'chatcmpl-local',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          reasoning_content: extra.thinking || undefined,
        },
        finish_reason: extra.finishReason || 'stop',
      },
    ],
    chatgpt: {
      session: extra.session,
      artifacts: extra.artifacts || [],
      url: extra.url,
      title: extra.title,
      model: extra.model,
      effort: extra.effort,
    },
  };
}

export function makeOpenAIChatCompletionChunk({ content = '', reasoningContent = '', finishReason = null, event = null } = {}) {
  const delta = {};
  if (content) delta.content = content;
  if (reasoningContent) delta.reasoning_content = reasoningContent;
  if (event) delta.chatgpt_event = event;

  return {
    id: 'chatcmpl-local',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}
