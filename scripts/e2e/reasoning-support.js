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
