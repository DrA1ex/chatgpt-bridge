import { clean, compactId, nowIso } from './turnManagerSupport.js';

export async function createAdoptedRecoveryTurn({ metadataStore, record, options = {} }) {
  const cwd = clean(options.cwd || options.projectRoot);
  const sessionId = clean(options.sessionId || options.conversationId);
  let threadId = clean(options.threadId);
  let thread = threadId ? await metadataStore.getThread(threadId) : null;
  if (!thread) {
    thread = await metadataStore.createThread({
      id: compactId('thread'),
      title: cwd ? `Recovered ${cwd.split(/[\/]/).filter(Boolean).pop() || 'project'}` : 'Recovered ChatGPT response',
      cwd,
      sessionId,
      metadata: { recovered: true, adoptedRecovery: true },
    });
    threadId = thread.id;
  }

  const index = Math.max(1, Number(options.index) || 1);
  const output = options.output && typeof options.output === 'object'
    ? options.output
    : (options.expectedOutput && typeof options.expectedOutput === 'object' ? options.expectedOutput : { expected: 'text', required: false });
  const message = clean(options.message) || `Recovered visible assistant response #${index}`;
  const turn = await metadataStore.createTurn({
    id: compactId('turn'),
    threadId,
    status: 'recovering',
    startedAt: nowIso(),
    input: {
      input: [{ type: 'text', text: message }],
      message,
      cwd,
      sessionId,
      sessionPolicy: 'reuse',
      project: options.project && typeof options.project === 'object' ? options.project : null,
      output,
      metadata: { recovered: true, adoptedRecovery: true, candidateIndex: index },
    },
  });
  await metadataStore.createItem({
    id: compactId('item'),
    threadId,
    turnId: turn.id,
    type: 'user_message',
    status: 'completed',
    content: { text: message, recovered: true, adoptedRecovery: true },
  });
  await record(turn.id, 'turn/recovery.adopted', { turnId: turn.id, threadId, cwd, sessionId, index, output });
  return turn;
}

export async function resolveExpectedOutput({ resultResolver, record, turnId, output = {}, response = {}, extra = {} }) {
  const expected = clean(output.expected || output.format);
  if (!(expected === 'zip' || output.required)) {
    return { type: 'text', answer: response.answer || '', artifacts: response.artifacts || [], response };
  }

  await record('result/resolving', { expected: expected || 'zip', ...extra });
  try {
    return await resultResolver.resolve({
      id: turnId,
      request: { output: { ...output, downloadUrl: `/turns/${turnId}/result/download` } },
    }, response, { onEvent: (type, data) => record(type, data) });
  } catch (error) {
    if (error.code !== 'EXPECTED_ZIP_ARTIFACT_NOT_FOUND') throw error;
    const answer = response.answer || response.response || '';
    const artifacts = Array.isArray(response.artifacts) ? response.artifacts : [];
    if (!output.required) {
      const result = { type: 'text', answer, text: answer, artifacts, response };
      await record('result/optional_artifact_absent', {
        expected: expected || 'zip', answerLength: String(answer).length, artifactCount: artifacts.length, ...extra,
      });
      return result;
    }
    const result = {
      type: 'text',
      status: 'missing_required_artifact',
      expected: expected || 'zip',
      answer,
      text: answer,
      artifacts,
      response,
      error: { code: error.code, message: error.message || String(error), recoverable: true, ...(error.extra ? { extra: error.extra } : {}) },
    };
    await record('result/missing_required_artifact', {
      expected: result.expected,
      answerLength: String(result.answer || '').length,
      artifactCount: result.artifacts.length,
      message: error.message || String(error),
      ...extra,
    });
    return result;
  }
}

export function completionStatusForResult(result = {}) {
  return result.status === 'missing_required_artifact' ? 'completed_without_artifact' : 'completed';
}
