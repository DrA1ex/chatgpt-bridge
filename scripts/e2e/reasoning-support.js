export const REASONING_PROGRESS_PERCENTAGES = Object.freeze(Array.from({ length: 11 }, (_, index) => index * 10));

export function reasoningTestPrompt(testId) {
  return [
    'This is a reasoning test.',
    '',
    'You are being tested on your ability to reason and provide output while reasoning.',
    '',
    'First, calculate the sum of the cubes of the integers from 1 to 100. Wait 100 ms before each addition. When you begin, print a user message with 0%, and then print another message with percentage after every 10% of the calculations, without stopping thinking.',
    '',
    'Then provide the result of the calculation. After that, continue reasoning. This time, the goal is to produce JavaScript code that calculates the same result without delays and outputs only the resulting number.',
    '',
    'At the beginning of the final answer, print:',
    `TEST_${testId}_BEGIN`,
    '',
    '',
    'At the end of the test, print:',
    `TEST_${testId}_FINISH`,
  ].join('\n');
}

export function extractReasoningProgressPercentages(domSnapshots = []) {
  const values = new Set();
  for (const snapshot of domSnapshots) {
    const texts = [
      snapshot?.rawText,
      snapshot?.raw,
      snapshot?.thinking,
      snapshot?.progress,
      ...(Array.isArray(snapshot?.progressItems) ? snapshot.progressItems.map((item) => item?.text) : []),
    ];
    const text = texts.filter(Boolean).join('\n');
    for (const match of text.matchAll(/(?:^|[^0-9])(100|[0-9]{1,2})%/g)) {
      const value = Number(match[1]);
      if (REASONING_PROGRESS_PERCENTAGES.includes(value)) values.add(value);
    }
  }
  return [...values].sort((a, b) => a - b);
}

export function validateReasoningFinalAnswer(finalText = '', testId = '', codeBlocks = []) {
  const failures = [];
  const begin = `TEST_${testId}_BEGIN`;
  const finish = `TEST_${testId}_FINISH`;
  const trimmed = String(finalText || '').trim();
  if (!trimmed.startsWith(begin)) failures.push(`Final answer does not begin with ${begin}`);
  if (!trimmed.endsWith(finish)) failures.push(`Final answer does not end with ${finish}`);
  if (!/(?:^|\D)25502500(?:\D|$)/.test(trimmed)) failures.push('Final answer does not contain the expected sum 25502500');
  const javascript = (codeBlocks || []).find((block) => /^(?:javascript|js|node|nodejs)$/i.test(String(block?.language || '')));
  if (!javascript) failures.push('Final answer has no JavaScript code block');
  const code = String(javascript?.code || '');
  if (javascript && !/console\.log\s*\(/.test(code)) failures.push('JavaScript code does not print the result with console.log');
  if (javascript && /setTimeout|setInterval|sleep|delay|100\s*ms/i.test(code)) failures.push('JavaScript code unexpectedly contains a delay');
  return { failures, begin, finish, javascript };
}

export function selectCompleteReasoningAttempt(attempts = []) {
  const valid = Array.from(attempts || []).filter((attempt) => (
    !attempt?.error
    && attempt?.snapshot?.turn?.status === 'completed'
    && Array.isArray(attempt?.finalValidation?.failures)
    && attempt.finalValidation.failures.length === 0
  ));
  const complete = valid
    .filter((attempt) => attempt?.coverage?.sufficient
      && (attempt?.missingPercentages?.length || 0) === 0
      && (attempt?.publicStreamValidation?.failures?.length || 0) === 0)
    .sort((left, right) => Number(right?.coverage?.score || 0) - Number(left?.coverage?.score || 0));
  return complete[0] || null;
}


function percentagesInText(value = '') {
  const values = new Set();
  for (const match of String(value || '').matchAll(/(?:^|[^0-9])(100|[0-9]{1,2})%/g)) {
    const percentage = Number(match[1]);
    if (REASONING_PROGRESS_PERCENTAGES.includes(percentage)) values.add(percentage);
  }
  return [...values].sort((left, right) => left - right);
}

export function validatePublicReasoningStream(records = [], options = {}) {
  const required = Array.isArray(options.requiredPercentages)
    ? options.requiredPercentages
    : REASONING_PROGRESS_PERCENTAGES;
  const failures = [];
  const eventRecords = records.filter((record) => record?.event === 'event' && record?.data?.type);
  const ready = records.find((record) => record?.event === 'ready') || null;
  const terminal = eventRecords.find((record) => [
    'turn/completed', 'turn/completed_without_artifact', 'turn/failed', 'turn/interrupted', 'turn/cancelled',
  ].includes(record.data.type)) || null;
  const finalMessage = eventRecords.find((record) => record.data.type === 'item/agentMessage/completed') || null;
  const snapshots = eventRecords.filter((record) => [
    'item/progress/snapshot', 'item/reasoning/snapshot',
  ].includes(record.data.type) && String(record.data.data?.text || '').trim());
  const completed = eventRecords.filter((record) => [
    'item/progress/completed', 'item/reasoning/completed',
  ].includes(record.data.type));

  if (!ready) failures.push('Public turn stream did not emit ready before the turn started');
  if (!terminal) failures.push('Public turn stream did not emit a terminal turn event');
  if (!finalMessage) failures.push('Public turn stream did not emit item/agentMessage/completed');

  const firstByPercentage = new Map();
  for (const record of snapshots) {
    for (const value of percentagesInText(record.data.data?.text || '')) {
      if (!firstByPercentage.has(value)) firstByPercentage.set(value, record);
    }
  }
  const missing = required.filter((value) => !firstByPercentage.has(value));
  if (missing.length) failures.push(`Public turn stream missed reasoning checkpoints: ${missing.map((value) => `${value}%`).join(', ')}`);

  let previousSequence = ready?.sequence || 0;
  for (const value of required) {
    const record = firstByPercentage.get(value);
    if (!record) continue;
    if (record.sequence <= previousSequence) {
      failures.push(`Public reasoning checkpoint ${value}% was not delivered as a later stream update`);
    }
    previousSequence = Math.max(previousSequence, record.sequence);
  }

  const first = firstByPercentage.get(required[0]);
  const last = firstByPercentage.get(required.at(-1));
  if (first && last) {
    const spreadMs = Number(last.receivedAtMs || 0) - Number(first.receivedAtMs || 0);
    const distinctReceiveTimes = new Set(required.map((value) => firstByPercentage.get(value)?.receivedAtMs).filter(Boolean)).size;
    if (spreadMs < 500) failures.push(`Public reasoning checkpoints arrived as a late batch (${spreadMs}ms from first to last)`);
    if (distinctReceiveTimes < Math.min(6, required.length)) failures.push(`Public reasoning checkpoints used only ${distinctReceiveTimes} distinct receive times`);
    if (finalMessage && last.sequence >= finalMessage.sequence) failures.push('100% was not delivered before the final agent message');
    if (terminal && last.sequence >= terminal.sequence) failures.push('100% was not delivered before the terminal turn event');
  }

  const snapshotIds = new Set(snapshots.map((record) => String(record.data.data?.logicalId || '')).filter(Boolean));
  const completedIds = new Set(completed.map((record) => String(record.data.data?.logicalId || '')).filter(Boolean));
  const uncompletedIds = [...snapshotIds].filter((id) => !completedIds.has(id));
  if (uncompletedIds.length) failures.push(`Public progress items were not completed: ${uncompletedIds.join(', ')}`);
  if (completed.length === 0) failures.push('Public turn stream emitted no progress completion wrapper');

  return {
    failures,
    ready,
    terminal,
    finalMessage,
    snapshots,
    completed,
    firstByPercentage: Object.fromEntries([...firstByPercentage].map(([value, record]) => [String(value), {
      sequence: record.sequence,
      receivedAt: record.receivedAt,
      eventTime: record.data.time || '',
      logicalId: record.data.data?.logicalId || '',
      revision: record.data.data?.revision || 0,
      text: record.data.data?.text || '',
    }])),
    spreadMs: first && last ? Number(last.receivedAtMs || 0) - Number(first.receivedAtMs || 0) : 0,
  };
}
