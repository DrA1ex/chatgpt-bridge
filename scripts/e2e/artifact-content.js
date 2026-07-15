export function normalizedArtifactText(bytes) {
  return Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n').trimEnd();
}

export function verifyArtifactContent(bytes, expectation = {}) {
  const actual = normalizedArtifactText(bytes);
  if (expectation.kind === 'json') {
    let parsed;
    try { parsed = JSON.parse(actual); }
    catch (error) { return { ok: false, actual, message: `Invalid JSON: ${error.message}` }; }
    const expectedJson = JSON.stringify(expectation.value);
    const actualJson = JSON.stringify(parsed);
    return actualJson === expectedJson
      ? { ok: true, actual, parsed }
      : { ok: false, actual, parsed, message: `Expected JSON ${expectedJson}, got ${actualJson}` };
  }
  const expected = String(expectation.value ?? '');
  return actual === expected
    ? { ok: true, actual }
    : { ok: false, actual, message: `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
}
