import { verifyArtifactContent } from '../artifact-content.js';
import { selectCompleteReasoningAttempt } from '../reasoning-support.js';

export async function runCoreScenarios(context = {}) {
  const {
    scenario,
    options,
    marker,
    sessionId,
    sessionUrl,
    testClient,
    workDir,
    runId,
    effortState,
    effortFor,
    FAST_EFFORT,
    DEFAULT_REASONING_EFFORT,
    REASONING_PROGRESS_PERCENTAGES,
    assert,
    testLog,
    step,
    logEvent,
    api,
    nowIso,
    sha256,
    normalizeAnswer,
    sendSynchronousMessage,
    createThread,
    startTurn,
    waitTurn,
    turnEvents,
    eventTypes,
    eventData,
    scenarioDiagnosticDir,
    createParserObservationWriter,
    firstDifference,
    logicalProgressId,
    mergeObservedProgress,
    progressRevisionTimeline,
    reasoningTestPrompt,
    extractReasoningProgressPercentages,
    validateReasoningFinalAnswer,
    validatePublicReasoningStream,
    openPublicTurnEventStream,
    readIntelligenceSnapshot,
    intelligenceSnapshotFromApplied,
    explicitSelectionCases,
    alternativeSelectionOption,
    optionLabel,
    selectionOptionMatches,
    waitForSteerWindow,
    artifactsFromResponse,
    artifactsFromTurn,
    selectArtifactCandidate,
    isZipArtifactCandidate,
    downloadArtifact,
    inspectZipBuffer,
    fs,
    path
  } = context;

  if (typeof effortFor !== 'function') throw new TypeError('Core E2E scenarios require effortFor(context)');

  await scenario('conversation', async () => {
    const control = `CONVERSATION_CONTROL_${marker}`;
    const first = await sendSynchronousMessage(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, {
      message: `This tests exact completion and conversation continuity. Output exactly ${control}.`,
      sourceClientId: testClient.id,
      effort: effortFor('conversation', FAST_EFFORT, 'exact-answer continuity does not require reasoning'),
    }, { scope: 'conversation', label: 'exact completion' });
    assert(normalizeAnswer(first.answer || first.response) === control, `Unexpected conversation answer: ${first.answer || first.response}`);
    const follow = await sendSynchronousMessage(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, {
      message: 'Using only the immediately previous message in this conversation, output exactly its control identifier and nothing else.',
      sourceClientId: testClient.id,
    }, { scope: 'conversation', label: 'continuity follow-up' });
    assert(normalizeAnswer(follow.answer || follow.response) === control, 'Conversation continuity failed');
    return { sessionId, sessionUrl, requestIds: [first.requestId, follow.requestId], control, memoryScopeExplicit: true };
  });

  await scenario('response-markdown', async () => {
    const diagnosticDir = scenarioDiagnosticDir(options, 'response-markdown');
    const observation = createParserObservationWriter(path.join(diagnosticDir, 'parser-observation.txt'));
    const thread = await createThread(options, '', `E2E response Markdown ${runId}`, { scope: 'response-markdown' });
    const jsCode = [
      `const marker = "${marker}";`,
      'const inlineLike = "`not a fence`";',
      'const fenceLike = "```still code```";',
      'const symbols = "<>&";',
      'function render(value) {',
      '  return marker + ":" + value;',
      '}',
      '',
      'console.log(render(symbols));',
    ].join('\n');
    const pythonCode = [
      `marker = "${marker}"`,
      'values = [1, 2, 3]',
      '',
      'def total(items):',
      '    return sum(items)',
      '',
      'print(f"{marker}:{total(values)}")',
    ].join('\n');
    const expectedAnswer = [
      `First paragraph ${marker} keeps inline \`const inlineValue = 42\`, embedded-backtick \`\` \`inlineLike\` \`\`, **bold text**, *italic text*, ~~removed text~~, Unicode café λ 漢字 and symbols < > &.`,
      '',
      'Second paragraph remains a separate block.',
      '',
      '````javascript',
      jsCode,
      '````',
      '',
      `Text between code blocks: ${marker}.`,
      '',
      '```python',
      pythonCode,
      '```',
      '',
      `PARSE_END_${marker}`,
    ].join('\n');
    const parserTurnId = `turn_e2e_${runId}_response_markdown`;
    const parserPrompt = [
      'Return exactly the Markdown payload below. Do not add an introduction, explanation, outer code fence, or trailing text.',
      'Preserve every paragraph break, inline-code span, code-block language, empty line, indentation, punctuation, and Unicode character.',
      'PAYLOAD START',
      expectedAnswer,
      'PAYLOAD END',
    ].join('\n\n');
    let parserSnapshot = null;
    let parserEvents = [];
    let parserAgent = null;
    let actualAnswer = '';
    let parsingDiff = null;
    let responseBlocks = [];
    let codeBlocks = [];
    let parserAudit = null;
    let parserDom = [];
    let answerSnapshots = [];
    let resultData = null;
    const validationFailures = [];
    const check = (condition, message) => { if (!condition) validationFailures.push(message); };

    try {
      await observation.initialize();
      step(`Live parser transcript: ${observation.filePath}`);
      await startTurn(options, {
        id: parserTurnId,
        threadId: thread.id,
        sessionId,
        sourceClientId: testClient.id,
        effort: effortFor('response-markdown', FAST_EFFORT, 'Markdown parsing does not require visible reasoning'),
        message: parserPrompt,
        metadata: { captureDomTimeline: true },
        output: { expected: 'text', required: false },
      }, { scope: 'response-markdown', label: 'structured Markdown response' });
      parserSnapshot = await waitTurn(options, parserTurnId, { onPoll: ({ events }) => observation.consume(events) });
      parserEvents = await turnEvents(options, parserTurnId);
      parserAgent = (parserSnapshot.items || []).find((item) => item.type === 'agent_message');
      actualAnswer = String(parserAgent?.content?.text || '').trim();
      parsingDiff = firstDifference(expectedAnswer, actualAnswer);
      responseBlocks = Array.isArray(parserAgent?.content?.blocks) ? parserAgent.content.blocks : [];
      codeBlocks = Array.isArray(parserAgent?.content?.codeBlocks) ? parserAgent.content.codeBlocks : [];
      parserAudit = parserAgent?.content?.parserAudit || null;
      parserDom = parserEvents.filter((event) => event.type === 'assistant.dom.snapshot').map(eventData);
      answerSnapshots = parserDom.map((snapshot) => String(snapshot.answer || '')).filter(Boolean);
      testLog('state', 'response-markdown', 'Completed response parser output collected', {
        responseBlocks: responseBlocks.length,
        blockTypes: responseBlocks.map((block) => block.type).join(','),
        codeBlocks: codeBlocks.length,
        domSnapshots: parserDom.length,
        answerChars: actualAnswer.length,
        coverage: parserAudit?.coverage?.coveragePercent ?? '(missing)',
        unknownLeaves: parserAudit?.coverage?.unknownLeaves ?? '(missing)',
      });

      check(parserSnapshot.turn.status === 'completed', `Response Markdown turn ended as ${parserSnapshot.turn.status}`);
      const expectedTypes = ['paragraph', 'paragraph', 'code_block', 'paragraph', 'code_block', 'paragraph'];
      check(responseBlocks.length === expectedTypes.length, `Expected ${expectedTypes.length} semantic response blocks, got ${responseBlocks.length}: ${JSON.stringify(responseBlocks.map((block) => block.type))}`);
      check(JSON.stringify(responseBlocks.map((block) => block.type)) === JSON.stringify(expectedTypes), `Response block order mismatch: ${JSON.stringify(responseBlocks.map((block) => block.type))}`);
      check(JSON.stringify(responseBlocks[0]?.inlineCode || []) === JSON.stringify(['const inlineValue = 42', '`inlineLike`']), `Inline code spans were not preserved exactly: ${JSON.stringify(responseBlocks[0])}`);
      check(codeBlocks.length === 2, `Expected 2 code blocks, got ${codeBlocks.length}`);
      check(codeBlocks[0]?.language === 'javascript', `JavaScript code block language mismatch: expected "javascript", actual ${JSON.stringify(codeBlocks[0]?.language || '')}`);
      check(codeBlocks[0]?.code === jsCode, `JavaScript code block content mismatch: ${JSON.stringify(firstDifference(jsCode, codeBlocks[0]?.code || ''))}`);
      check(codeBlocks[1]?.language === 'python', `Python code block language mismatch: expected "python", actual ${JSON.stringify(codeBlocks[1]?.language || '')}`);
      check(codeBlocks[1]?.code === pythonCode, `Python code block content mismatch: ${JSON.stringify(firstDifference(pythonCode, codeBlocks[1]?.code || ''))}`);
      check(!parsingDiff, `Final Markdown mismatch at offset ${parsingDiff?.offset}: expected ${JSON.stringify(parsingDiff?.expected)}, actual ${JSON.stringify(parsingDiff?.actual)}`);
      check(parserDom.length > 0, 'No raw DOM snapshots were recorded for the Markdown parser turn');
      check(answerSnapshots.at(-1)?.trim() === expectedAnswer, 'Last DOM answer snapshot does not equal the completed Markdown answer');
      check(Boolean(parserAudit), 'Completed agent message has no parser audit');
      const coverage = parserAudit?.coverage || {};
      check(Number(coverage.unknownLeaves || 0) === 0, `Parser audit found ${coverage.unknownLeaves || 0} unclassified visible text leaves`);
      check(Number(coverage.unknownVisualElements || 0) === 0, `Parser audit found ${coverage.unknownVisualElements || 0} unclassified visual elements`);
      check(Number(coverage.duplicateLeaves || 0) === 0, `Parser audit found ${coverage.duplicateLeaves || 0} text leaves with duplicate ownership`);
      check(Number(coverage.coveragePercent || 0) === 100, `Parser audit coverage is ${coverage.coveragePercent || 0}% instead of 100%`);
      check(!responseBlocks.some((block) => block.type === 'unknown'), `Parser returned unknown response blocks: ${JSON.stringify(responseBlocks.filter((block) => block.type === 'unknown'))}`);
      for (const [snapshotIndex, dom] of parserDom.entries()) {
        const audit = dom.parserAudit;
        if (!audit?.coverage) continue;
        check(Number(audit.coverage.duplicateLeaves || 0) === 0, `Streaming DOM snapshot ${snapshotIndex + 1} has duplicate leaf ownership`);
      }
      resultData = {
        turnId: parserTurnId,
        responseBlockTypes: responseBlocks.map((block) => block.type),
        codeBlocks: codeBlocks.map((block) => ({ language: block.language, chars: block.code?.length || 0 })),
        answerSnapshotCount: answerSnapshots.length,
        parserCoverage: parserAudit?.coverage || null,
        unknownItems: parserAudit?.unknownItems || [],
        observationFile: observation.filePath,
        validationFailures,
      };
      if (validationFailures.length) {
        const error = new Error(`Response Markdown validation found ${validationFailures.length} issue(s): ${validationFailures.join(' | ')}`);
        error.name = 'ResponseMarkdownValidationError';
        error.validationFailures = validationFailures;
        throw error;
      }
    } finally {
      if (!parserSnapshot) parserSnapshot = await api(options, `/turns/${encodeURIComponent(parserTurnId)}`).catch(() => null);
      if (!parserEvents.length) parserEvents = await turnEvents(options, parserTurnId).catch(() => []);
      if (!parserAgent) parserAgent = (parserSnapshot?.items || []).find((item) => item.type === 'agent_message') || null;
      if (!actualAnswer) actualAnswer = String(parserAgent?.content?.text || '').trim();
      if (!responseBlocks.length) responseBlocks = Array.isArray(parserAgent?.content?.blocks) ? parserAgent.content.blocks : [];
      if (!codeBlocks.length) codeBlocks = Array.isArray(parserAgent?.content?.codeBlocks) ? parserAgent.content.codeBlocks : [];
      if (!parserAudit) parserAudit = parserAgent?.content?.parserAudit || null;
      if (!parserDom.length) parserDom = parserEvents.filter((event) => event.type === 'assistant.dom.snapshot').map(eventData);
      if (!answerSnapshots.length) answerSnapshots = parserDom.map((snapshot) => String(snapshot.answer || '')).filter(Boolean);
      parsingDiff = firstDifference(expectedAnswer, actualAnswer);
      const diagnosticSnapshot = [...parserDom].reverse().find((snapshot) => Array.isArray(snapshot?.codeBlockDiagnostics) && snapshot.codeBlockDiagnostics.length) || parserDom.at(-1) || null;
      const storedCodeBlockDiagnostics = Array.isArray(parserAgent?.content?.codeBlockDiagnostics) ? parserAgent.content.codeBlockDiagnostics : [];
      const codeBlockDomDiagnostics = storedCodeBlockDiagnostics.length ? storedCodeBlockDiagnostics : (diagnosticSnapshot?.codeBlockDiagnostics || []);
      const terminalAudit = parserAudit || diagnosticSnapshot?.parserAudit || null;
      const terminalObservation = {
        ...(diagnosticSnapshot || {}),
        answer: actualAnswer,
        responseBlocks,
        codeBlocks,
        parserAudit: terminalAudit,
        progressItems: diagnosticSnapshot?.progressItems || [],
        rawText: diagnosticSnapshot?.rawText || diagnosticSnapshot?.raw || '',
      };
      await observation.appendTerminal(terminalObservation, { at: nowIso() }).catch((err) => step(`Warning: could not append terminal parser observation: ${err.message}`));
      await fs.mkdir(diagnosticDir, { recursive: true }).catch(() => {});
      await Promise.all([
        fs.writeFile(path.join(diagnosticDir, 'expected-answer.md'), `${expectedAnswer}\n`),
        fs.writeFile(path.join(diagnosticDir, 'final-answer.md'), `${actualAnswer}\n`),
        fs.writeFile(path.join(diagnosticDir, 'parser-audit.json'), `${JSON.stringify(terminalAudit, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'response-blocks.json'), `${JSON.stringify(responseBlocks, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'reasoning-blocks.json'), `${JSON.stringify(diagnosticSnapshot?.progressItems || [], null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'unknown-nodes.json'), `${JSON.stringify(terminalAudit?.unknownItems || [], null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'terminal-dom.html'), String(terminalAudit?.sourceHtml || codeBlockDomDiagnostics.map((item) => item.domContext || '').join('\n') || '')),
        fs.writeFile(path.join(diagnosticDir, 'response-parsing-diff.json'), `${JSON.stringify({
          diff: parsingDiff,
          expectedBlockTypes: ['paragraph', 'paragraph', 'code_block', 'paragraph', 'code_block', 'paragraph'],
          actualBlockTypes: responseBlocks.map((block) => block.type),
          expectedCodeBlocks: [{ language: 'javascript', code: jsCode }, { language: 'python', code: pythonCode }],
          actualCodeBlocks: codeBlocks,
          codeBlockDomDiagnostics,
          parserAudit: terminalAudit,
          validationFailures,
        }, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'code-block-dom-context.json'), `${JSON.stringify(codeBlockDomDiagnostics, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'raw-dom-timeline.json'), `${JSON.stringify(parserDom.map((snapshot) => ({ turnId: parserTurnId, ...snapshot })), null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'parsed-timeline.json'), `${JSON.stringify({ turnId: parserTurnId, responseBlocks, codeBlocks, codeBlockDomDiagnostics, parserAudit: terminalAudit, answerSnapshots, validationFailures }, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'stored-items.json'), `${JSON.stringify([{ turnId: parserTurnId, items: parserSnapshot?.items || [] }], null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'turn-events.json'), `${JSON.stringify([{ turnId: parserTurnId, events: parserEvents }], null, 2)}\n`),
      ]).catch((err) => step(`Warning: could not write response-markdown diagnostics: ${err.message}`));
      logEvent('response-markdown.diagnostics', { parserTurnId, responseBlocks, codeBlocks, parsingDiff, validationFailures, answerSnapshotCount: answerSnapshots.length });
    }
    return resultData;
  });

  await scenario('reasoning-lifecycle', async (entry) => {
    const scope = 'reasoning-lifecycle';
    const diagnosticDir = scenarioDiagnosticDir(options, 'reasoning-lifecycle');
    const thread = await createThread(options, '', `E2E reasoning lifecycle ${runId}`, { scope });
    const attempts = [];
    let resultData = null;

    const genericReasoningLabel = (value = '') => /^(?:thinking|reasoning|analyzing|working|processing|\u0434\u0443\u043c(?:\u0430\u044e|\u0430\u0435\u0442|\u0430)|\u0440\u0430\u0437\u043c\u044b\u0448\u043b\u044f\u044e|\u0430\u043d\u0430\u043b\u0438\u0437\u0438\u0440\u0443\u044e|\u043e\u0431\u0440\u0430\u0431\u0430\u0442\u044b\u0432\u0430\u044e)\s*(?:\.|…)?$/iu.test(String(value || '').trim());
    const coverageFor = (record) => {
      const thinking = record.observed.filter((item) => item.kind === 'thinking');
      const substantive = thinking.filter((item) => String(item.text || '').trim().length >= 8 && !genericReasoningLabel(item.text));
      const maxRevision = Math.max(0, ...thinking.map((item) => Number(item.revision || 0)));
      const maxChars = Math.max(0, ...substantive.map((item) => String(item.text || '').length));
      const progressComplete = record.missingPercentages.length === 0;
      const score = (progressComplete ? 1_000_000 : 0) + record.progressPercentages.length * 10_000 + substantive.length * 1_000 + maxRevision * 100 + maxChars;
      return { thinking, substantive, maxRevision, maxChars, progressComplete, score, sufficient: progressComplete };
    };
    const verifyObservedItems = (attempt) => {
      const stored = (attempt.snapshot?.items || []).filter((item) => item.type === 'reasoning' || item.type === 'progress');
      const storedByLogicalId = new Map(stored.map((item) => [String(item.content?.logicalId || ''), item]));
      for (const phase of attempt.observed) {
        const id = logicalProgressId(phase);
        const storedItem = storedByLogicalId.get(id);
        assert(storedItem, `Visible ${phase.kind || 'progress'} phase ${id} was not stored for ${attempt.turnId}`);
        const expectedType = phase.kind === 'thinking' ? 'reasoning' : 'progress';
        assert(storedItem.type === expectedType, `Visible phase ${id} changed type from ${phase.kind} to ${storedItem.type}`);
        assert(storedItem.status === 'completed', `Visible phase ${id} remained ${storedItem.status}`);
        assert(String(storedItem.content?.text || '') === String(phase.text || ''), `Visible phase ${id} was truncated or changed: ${JSON.stringify(firstDifference(phase.text || '', storedItem.content?.text || ''))}`);
        assert(String(storedItem.content?.text || '').length > 0, `Visible phase ${id} was overwritten with an empty snapshot`);
        assert(Number(storedItem.content?.revision || 0) >= Number(phase.revision || 0), `Visible phase ${id} lost revisions: observed=${phase.revision || 0} stored=${storedItem.content?.revision || 0}`);
        assert(!attempt.finalText.includes(String(storedItem.content?.text || '')), `Visible phase ${id} leaked into the final answer`);
      }
      const observedOrder = attempt.observed.map((item) => logicalProgressId(item));
      const storedOrder = stored.map((item) => String(item.content?.logicalId || '')).filter((id) => observedOrder.includes(id));
      assert(JSON.stringify(storedOrder) === JSON.stringify(observedOrder), `Visible phase order changed for ${attempt.turnId}: observed=${JSON.stringify(observedOrder)} stored=${JSON.stringify(storedOrder)}`);
      const timelineById = new Map();
      for (const revisionEntry of attempt.revisionTimeline || []) {
        const entries = timelineById.get(revisionEntry.id) || [];
        const previous = entries.at(-1) || null;
        if (previous) {
          assert(revisionEntry.revision >= previous.revision, `Visible phase ${revisionEntry.id} revision decreased from ${previous.revision} to ${revisionEntry.revision}`);
          assert(!(revisionEntry.revision === previous.revision && revisionEntry.text !== previous.text), `Visible phase ${revisionEntry.id} changed text without incrementing revision ${revisionEntry.revision}`);
        }
        entries.push(revisionEntry);
        timelineById.set(revisionEntry.id, entries);
      }
      for (const phase of attempt.observed) {
        const id = logicalProgressId(phase);
        const last = (timelineById.get(id) || []).at(-1);
        assert(last, `Visible phase ${id} has no revision timeline`);
        assert(String(last.text || '') === String(phase.text || ''), `Visible phase ${id} final revision differs from the observed final phase`);
      }
      if (attempt.observed.some((item) => item.kind === 'thinking' || item.kind === 'progress')) {
        const firstProgressIndex = attempt.domSnapshots.findIndex((dom) => (dom.progressItems || []).some((item) => item?.text));
        const finalIndex = attempt.domSnapshots.findIndex((dom, index) => index > firstProgressIndex && String(dom.answer || '').trim().startsWith(attempt.beginMarker) && String(dom.answer || '').trim().endsWith(attempt.finishMarker));
        assert(firstProgressIndex >= 0 && finalIndex > firstProgressIndex, `Reasoning-to-final transition was not observed in order for ${attempt.turnId}: progress=${firstProgressIndex} final=${finalIndex}`);
      }
      return stored;
    };

    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const testId = `${marker}_R${attempt}`;
        const turnId = `turn_e2e_${runId}_reasoning_lifecycle_${attempt}`;
        const prompt = reasoningTestPrompt(testId);
        const beginMarker = `TEST_${testId}_BEGIN`;
        const finishMarker = `TEST_${testId}_FINISH`;
        let snapshot = null;
        let events = [];
        let error = null;
        const loggedPublicPercentages = new Set();
        const publicStream = openPublicTurnEventStream(options, turnId, {
          timeoutMs: Math.max(options.turnMaxTimeoutMs || 0, options.resultIdleTimeoutMs + options.pipelineIdleTimeoutMs + 60_000),
          onRecord(record) {
            if (record?.event !== 'event' || !['item/progress/snapshot', 'item/reasoning/snapshot'].includes(record?.data?.type)) return;
            const text = String(record.data.data?.text || '');
            for (const match of text.matchAll(/(?:^|[^0-9])(100|[0-9]{1,2})%/g)) {
              const percentage = Number(match[1]);
              if (!REASONING_PROGRESS_PERCENTAGES.includes(percentage) || loggedPublicPercentages.has(percentage)) continue;
              loggedPublicPercentages.add(percentage);
              testLog('progress', scope, 'Public reasoning progress delivered', {
                attempt,
                progress: `${percentage}%`,
                sequence: record.sequence,
                logicalId: record.data.data?.logicalId || '',
                revision: record.data.data?.revision || 0,
              });
            }
          },
        });
        let publicStreamRecords = [];
        let publicStreamValidation = null;

        testLog('step', scope, 'Starting reasoning lifecycle attempt', { attempt, testId, beginMarker, finishMarker });
        try {
          await publicStream.waitReady(Math.max(options.timeoutMs, 15_000));
          const requestedReasoningEffort = options.efforts[0] || DEFAULT_REASONING_EFFORT;
          await startTurn(options, {
            id: turnId,
            threadId: thread.id,
            sessionId,
            sourceClientId: testClient.id,
            model: options.models[0] || '',
            effort: effortFor(scope, requestedReasoningEffort, 'visible reasoning and percentage progress are required'),
            metadata: { captureDomTimeline: true },
            message: prompt,
            output: { expected: 'text', required: false },
          }, { scope, label: `reasoning attempt ${attempt}` });
          snapshot = await waitTurn(options, turnId, { scope });
          events = await turnEvents(options, turnId);
          await publicStream.waitDone(Math.max(options.turnMaxTimeoutMs || 0, options.resultIdleTimeoutMs + options.pipelineIdleTimeoutMs + 60_000));
        } catch (err) {
          error = { message: err.message, stack: err.stack };
          snapshot = snapshot || await api(options, `/turns/${encodeURIComponent(turnId)}`).catch(() => null);
          events = events.length ? events : await turnEvents(options, turnId).catch(() => []);
        } finally {
          publicStreamRecords = [...publicStream.records];
          publicStream.close();
        }

        publicStreamValidation = validatePublicReasoningStream(publicStreamRecords, {
          requiredPercentages: REASONING_PROGRESS_PERCENTAGES,
        });
        const agent = (snapshot?.items || []).find((item) => item.type === 'agent_message');
        const finalText = String(agent?.content?.text || '').trim();
        const codeBlocks = Array.isArray(agent?.content?.codeBlocks) ? agent.content.codeBlocks : [];
        const finalValidation = validateReasoningFinalAnswer(finalText, testId, codeBlocks);
        const domSnapshots = events.filter((event) => event.type === 'assistant.dom.snapshot').map(eventData);
        const observed = mergeObservedProgress(domSnapshots.flatMap((dom) => Array.isArray(dom.progressItems) ? dom.progressItems : []));
        const revisionTimeline = progressRevisionTimeline(domSnapshots);
        const progressPercentages = extractReasoningProgressPercentages(domSnapshots);
        const missingPercentages = REASONING_PROGRESS_PERCENTAGES.filter((value) => !progressPercentages.includes(value));
        const record = {
          turnId,
          testId,
          prompt,
          beginMarker,
          finishMarker,
          finalText,
          finalValidation,
          codeBlocks,
          snapshot,
          events,
          domSnapshots,
          observed,
          revisionTimeline,
          progressPercentages,
          missingPercentages,
          items: snapshot?.items || [],
          publicStreamRecords,
          publicStreamValidation,
          error,
        };
        record.coverage = coverageFor(record);
        attempts.push(record);
        testLog('state', scope, 'Reasoning attempt parsed', {
          attempt,
          visiblePhases: observed.length,
          progress: progressPercentages.join(',') || '(none)',
          missing: missingPercentages.join(',') || '(none)',
          finalIssues: finalValidation.failures.length,
          codeBlocks: codeBlocks.length,
          publicStreamIssues: publicStreamValidation.failures.length,
          publicStreamSpreadMs: publicStreamValidation.spreadMs,
        });
        if (record.coverage.sufficient && !record.finalValidation.failures.length && !record.publicStreamValidation.failures.length) break;
        if (attempt < 2) testLog('retry', scope, 'Reasoning output was not yet conclusive; starting the second isolated attempt', { missingPercentages: missingPercentages.join(','), finalIssues: finalValidation.failures.join(' | ') });
      }

      for (const attempt of attempts) {
        if (attempt.error) throw Object.assign(new Error(`Reasoning lifecycle request ${attempt.turnId} failed: ${attempt.error.message}`), { stack: attempt.error.stack });
        assert(attempt.snapshot?.turn?.status === 'completed', `Reasoning lifecycle turn ${attempt.turnId} ended as ${attempt.snapshot?.turn?.status || 'missing'}`);
        assert(attempt.finalValidation.failures.length === 0, `Reasoning final-answer validation failed for ${attempt.turnId}: ${attempt.finalValidation.failures.join(' | ')}`);
        attempt.stored = verifyObservedItems(attempt);
      }

      const reasoningResult = selectCompleteReasoningAttempt(attempts);
      if (!reasoningResult) {
        const publicContractFailures = attempts
          .filter((attempt) => attempt.coverage?.sufficient && attempt.finalValidation?.failures?.length === 0)
          .flatMap((attempt) => (attempt.publicStreamValidation?.failures || []).map((failure) => `${attempt.turnId}: ${failure}`));
        if (publicContractFailures.length) {
          throw new Error(`Public reasoning stream contract failed: ${publicContractFailures.join(' | ')}`);
        }
        entry.status = options.strictReasoning ? 'failed' : 'inconclusive';
        const partial = attempts
          .filter((attempt) => attempt.progressPercentages.length > 0 && attempt.missingPercentages.length > 0)
          .map((attempt) => `${attempt.turnId}: missing ${attempt.missingPercentages.map((value) => `${value}%`).join(', ')}`)
          .join('; ');
        entry.note = `ChatGPT completed the deterministic final answer, but no complete 0%-100% visible progress sequence was exposed in either attempt.${partial ? ` ${partial}` : ''}`;
        if (options.strictReasoning) throw new Error(entry.note);
        resultData = {
          reasoningTurnId: '',
          reasoningPhases: [],
          attempts: attempts.map((attempt) => ({
            turnId: attempt.turnId,
            testId: attempt.testId,
            progressPercentages: attempt.progressPercentages,
            missingPercentages: attempt.missingPercentages,
            observedCount: attempt.observed.length,
            storedCount: attempt.stored?.length || 0,
          })),
        };
        return resultData;
      }

      testLog('ok', scope, 'Complete reasoning lifecycle was observed and preserved', {
        turnId: reasoningResult.turnId,
        progress: reasoningResult.progressPercentages.map((value) => `${value}%`).join(','),
        phases: reasoningResult.observed.length,
        result: 25502500,
        publicStreamSpreadMs: reasoningResult.publicStreamValidation.spreadMs,
      });
      resultData = {
        reasoningTurnId: reasoningResult.turnId,
        testId: reasoningResult.testId,
        beginMarker: reasoningResult.beginMarker,
        finishMarker: reasoningResult.finishMarker,
        progressPercentages: reasoningResult.progressPercentages,
        reasoningPhases: reasoningResult.coverage.thinking.map((item) => ({ id: logicalProgressId(item), revision: item.revision, chars: String(item.text || '').length, generic: genericReasoningLabel(item.text) })),
        visibleAuxiliaryPhases: reasoningResult.observed.filter((item) => item.kind !== 'thinking').map((item) => ({ id: logicalProgressId(item), kind: item.kind, revision: item.revision, chars: String(item.text || '').length })),
        publicProgressStream: {
          spreadMs: reasoningResult.publicStreamValidation.spreadMs,
          firstByPercentage: reasoningResult.publicStreamValidation.firstByPercentage,
          completionCount: reasoningResult.publicStreamValidation.completed.length,
        },
        attempts: attempts.map((attempt) => ({
          turnId: attempt.turnId,
          testId: attempt.testId,
          progressPercentages: attempt.progressPercentages,
          missingPercentages: attempt.missingPercentages,
          observedCount: attempt.observed.length,
          storedCount: attempt.stored?.length || 0,
          coverageScore: attempt.coverage.score,
          publicStreamFailures: attempt.publicStreamValidation?.failures || [],
          publicStreamSpreadMs: attempt.publicStreamValidation?.spreadMs || 0,
        })),
      };
    } finally {
      const allDomSnapshots = attempts.flatMap((attempt) => attempt.domSnapshots.map((snapshot) => ({ turnId: attempt.turnId, testId: attempt.testId, ...snapshot })));
      const allEvents = attempts.map((attempt) => ({ turnId: attempt.turnId, testId: attempt.testId, events: attempt.events }));
      const allItems = attempts.map((attempt) => ({ turnId: attempt.turnId, testId: attempt.testId, items: attempt.items }));
      const allPublicProgressEvents = attempts.map((attempt) => ({
        turnId: attempt.turnId,
        testId: attempt.testId,
        validation: attempt.publicStreamValidation,
        records: attempt.publicStreamRecords,
      }));
      await fs.mkdir(diagnosticDir, { recursive: true }).catch(() => {});
      const writes = [
        fs.writeFile(path.join(diagnosticDir, 'raw-dom-timeline.json'), `${JSON.stringify(allDomSnapshots, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'parsed-timeline.json'), `${JSON.stringify({ attempts: attempts.map((attempt) => ({ turnId: attempt.turnId, testId: attempt.testId, beginMarker: attempt.beginMarker, finishMarker: attempt.finishMarker, finalText: attempt.finalText, finalValidation: attempt.finalValidation, progressPercentages: attempt.progressPercentages, missingPercentages: attempt.missingPercentages, observed: attempt.observed, revisionTimeline: attempt.revisionTimeline || [], stored: attempt.stored || [], coverage: attempt.coverage, error: attempt.error })) }, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'stored-items.json'), `${JSON.stringify(allItems, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'turn-events.json'), `${JSON.stringify(allEvents, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'public-progress-events.json'), `${JSON.stringify(allPublicProgressEvents, null, 2)}\n`),
        fs.writeFile(path.join(diagnosticDir, 'reasoning-attempts.json'), `${JSON.stringify(attempts.map((attempt) => ({ turnId: attempt.turnId, testId: attempt.testId, progressPercentages: attempt.progressPercentages, missingPercentages: attempt.missingPercentages, finalValidation: attempt.finalValidation, publicStreamFailures: attempt.publicStreamValidation?.failures || [], publicStreamSpreadMs: attempt.publicStreamValidation?.spreadMs || 0, codeBlocks: attempt.codeBlocks })), null, 2)}\n`),
      ];
      for (const [index, attempt] of attempts.entries()) {
        writes.push(fs.writeFile(path.join(diagnosticDir, `reasoning-prompt-attempt-${index + 1}.txt`), `${attempt.prompt}\n`));
        writes.push(fs.writeFile(path.join(diagnosticDir, `final-answer-attempt-${index + 1}.txt`), `${attempt.finalText}\n`));
      }
      await Promise.all(writes).catch((err) => step(`Warning: could not write reasoning-lifecycle diagnostics: ${err.message}`));
      logEvent('reasoning-lifecycle.diagnostics', { attempts: attempts.map((attempt) => ({ turnId: attempt.turnId, testId: attempt.testId, progressPercentages: attempt.progressPercentages, missingPercentages: attempt.missingPercentages, observedCount: attempt.observed.length, error: attempt.error?.message || '' })) });
    }
    return resultData;
  });
  await scenario('model-effort', async () => {
    const scope = 'model-effort';
    const initialState = await readIntelligenceSnapshot(options, { scope, reason: 'capture the original settings and available options' });
    assert(initialState.models.length > 0, 'Model picker returned no internal model list');
    assert(initialState.efforts.length > 0, 'Effort picker returned no internal effort list');
    assert(initialState.models.every((item) => item?.id && item?.value && item?.label), `Model picker returned an unnormalized option: ${JSON.stringify(initialState.models)}`);
    assert(initialState.efforts.every((item) => item?.id && item?.value && item?.label), `Effort picker returned an unnormalized option: ${JSON.stringify(initialState.efforts)}`);

    const originalModel = initialState.currentModel;
    const originalEffort = initialState.currentEffort;
    assert(optionLabel(originalModel), `Model picker did not expose a current model: ${JSON.stringify(initialState)}`);
    assert(optionLabel(originalEffort), `Effort picker did not expose a current effort: ${JSON.stringify(initialState)}`);
    testLog('ok', scope, 'Original settings captured', { model: optionLabel(originalModel), effort: optionLabel(originalEffort) });
    effortState.expectedUiEffort = String(originalEffort?.value || originalEffort?.id || optionLabel(originalEffort) || '').trim().toLowerCase();

    const thread = await createThread(options, '', `E2E model effort ${runId}`, { scope });
    const verified = [];
    let primaryError = null;
    let selectionMayHaveChanged = false;
    let restoreResult = null;
    let lastKnownState = initialState;

    const executeSelectionCase = async (selected, index, {
      beforeState = lastKnownState,
      mustChangeModel = false,
      mustChangeEffort = false,
      purpose = 'selection',
    } = {}) => {
      const beforeCurrent = { model: beforeState.currentModel, effort: beforeState.currentEffort };
      const turnId = `turn_e2e_${runId}_model_effort_${index + 1}`;
      const expected = 'MODEL_EFFORT_OK';
      testLog('step', scope, `Starting ${purpose}`, {
        turn: index + 1,
        requestedModel: selected.model || '(unchanged)',
        requestedEffort: selected.effort || '(unchanged)',
        beforeModel: optionLabel(beforeCurrent.model),
        beforeEffort: optionLabel(beforeCurrent.effort),
      });
      testLog('action', scope, 'Submitting one deterministic ChatGPT turn with the requested settings', { turnId });
      await startTurn(options, {
        id: turnId,
        threadId: thread.id,
        sessionId,
        sourceClientId: testClient.id,
        ...(selected.model ? { model: selected.model } : {}),
        ...(selected.effort ? { effort: selected.effort } : {}),
        message: `This is a short browser E2E check for model and reasoning-effort selection. Do not save anything from this request to account-wide memory. Output exactly ${expected} and nothing else.`,
        output: { expected: 'text', required: false },
      }, { scope, label: purpose });
      testLog('wait', scope, 'Waiting for model/effort application and the deterministic answer', { turnId });
      const snapshot = await waitTurn(options, turnId, { scope });
      const events = await turnEvents(options, turnId);
      const agentMessages = (snapshot.items || []).filter((item) => item.type === 'agent_message');
      const agent = agentMessages.at(-1);
      assert(snapshot.turn.status === 'completed', `Model/effort ${purpose} case ${index + 1} ended as ${snapshot.turn.status}`);
      assert(agentMessages.length === 1, `Model/effort ${purpose} case ${index + 1} stored ${agentMessages.length} agent messages instead of one`);
      assert(normalizeAnswer(agent?.content?.text || '') === expected, `Model/effort ${purpose} case ${index + 1} answer mismatch: ${agent?.content?.text || ''}`);
      testLog('ok', scope, 'Deterministic answer received', { turnId, answer: expected });

      const startedEvent = events.find((event) => event.type === 'model.apply.started');
      const applyEvent = events.find((event) => event.type === 'model.apply.done');
      const applied = eventData(applyEvent || {});
      assert(startedEvent, `Model/effort application did not start for ${purpose} case ${index + 1}`);
      assert(applyEvent, `Model/effort application did not finish for ${purpose} case ${index + 1}`);
      if (selected.model) assert(applied.modelApplied === true, `Model was not confirmed for ${purpose} case ${index + 1}: ${selected.model}; warnings=${JSON.stringify(applied.warnings || [])}`);
      if (selected.effort) assert(applied.effortApplied === true, `Effort was not confirmed for ${purpose} case ${index + 1}: ${selected.effort}; warnings=${JSON.stringify(applied.warnings || [])}`);

      const afterState = intelligenceSnapshotFromApplied(applied, beforeState);
      assert(applied.intelligence, `Model/effort ${purpose} did not return the internally verified picker state`);
      testLog('state', scope, 'Using the picker state already verified by the extension', {
        model: optionLabel(afterState.currentModel),
        effort: optionLabel(afterState.currentEffort),
      });
      const afterCurrent = { model: afterState.currentModel, effort: afterState.currentEffort };
      if (selected.model) assert(selectionOptionMatches(afterCurrent.model, selected.model), `Model picker no longer reports ${selected.model} as selected after ${purpose} case ${index + 1}: ${JSON.stringify(afterCurrent.model)}`);
      if (selected.effort) assert(selectionOptionMatches(afterCurrent.effort, selected.effort), `Effort picker no longer reports ${selected.effort} as selected after ${purpose} case ${index + 1}: ${JSON.stringify(afterCurrent.effort)}`);
      if (mustChangeModel) assert(!selectionOptionMatches(beforeCurrent.model, optionLabel(afterCurrent.model)), `Model did not actually change during ${purpose}: before=${JSON.stringify(beforeCurrent.model)} after=${JSON.stringify(afterCurrent.model)}`);
      if (mustChangeEffort) assert(!selectionOptionMatches(beforeCurrent.effort, optionLabel(afterCurrent.effort)), `Effort did not actually change during ${purpose}: before=${JSON.stringify(beforeCurrent.effort)} after=${JSON.stringify(afterCurrent.effort)}`);
      testLog('ok', scope, `${purpose} verified`, { model: optionLabel(afterCurrent.model), effort: optionLabel(afterCurrent.effort) });

      const modelSlug = events.map(eventData).map((data) => data.modelSlug).find(Boolean) || '';
      const result = { turnId, purpose, requested: selected, applied, before: beforeCurrent, after: afterCurrent, modelSlug, answer: expected };
      verified.push(result);
      lastKnownState = afterState;
      effortState.expectedUiEffort = String(afterState.currentEffort?.value || afterState.currentEffort?.id || optionLabel(afterState.currentEffort) || '').trim().toLowerCase();
      if (mustChangeModel || mustChangeEffort || (selected.model && !selectionOptionMatches(originalModel, selected.model)) || (selected.effort && !selectionOptionMatches(originalEffort, selected.effort))) selectionMayHaveChanged = true;
      return { result, state: afterState };
    };

    try {
      if (options.models.length || options.efforts.length) {
        const requestedSelectionCases = explicitSelectionCases(options);
        for (let index = 0; index < requestedSelectionCases.length; index += 1) {
          await executeSelectionCase(requestedSelectionCases[index], index, { beforeState: lastKnownState, purpose: 'explicit selection' });
        }
      } else {
        const alternateModel = alternativeSelectionOption(initialState.models, originalModel);
        assert(alternateModel, `Default model-effort E2E requires a second selectable model; current=${JSON.stringify(originalModel)} available=${JSON.stringify(initialState.models)}`);
        testLog('state', scope, 'Automatic model target chosen', { from: optionLabel(originalModel), to: optionLabel(alternateModel) });
        const modelSwitch = await executeSelectionCase(
          { model: optionLabel(alternateModel), effort: '', mode: 'automatic-switch' },
          0,
          { beforeState: initialState, mustChangeModel: true, purpose: 'model switch' },
        );

        const alternateEffort = alternativeSelectionOption(modelSwitch.state.efforts, modelSwitch.state.currentEffort);
        assert(alternateEffort, `Default model-effort E2E requires a second selectable effort after switching model; current=${JSON.stringify(modelSwitch.state.currentEffort)} available=${JSON.stringify(modelSwitch.state.efforts)}`);
        testLog('state', scope, 'Automatic effort target chosen', { from: optionLabel(modelSwitch.state.currentEffort), to: optionLabel(alternateEffort) });
        await executeSelectionCase(
          { model: '', effort: optionLabel(alternateEffort), mode: 'automatic-switch' },
          1,
          { beforeState: modelSwitch.state, mustChangeEffort: true, purpose: 'effort switch' },
        );
      }
    } catch (err) {
      primaryError = err;
      throw err;
    } finally {
      let currentState = lastKnownState;
      if (primaryError) {
        currentState = await readIntelligenceSnapshot(options, { scope, reason: 'recover the current state after a failed selection step' }).catch(() => lastKnownState);
      }
      const needsRestore = selectionMayHaveChanged
        || !selectionOptionMatches(currentState.currentModel || {}, optionLabel(originalModel))
        || !selectionOptionMatches(currentState.currentEffort || {}, optionLabel(originalEffort));
      if (needsRestore) {
        try {
          const restoreIndex = verified.length + 1;
          const turnId = `turn_e2e_${runId}_model_effort_restore`;
          const expected = 'MODEL_EFFORT_RESTORED';
          testLog('step', scope, 'Restoring the original model and effort', { model: optionLabel(originalModel), effort: optionLabel(originalEffort) });
          await startTurn(options, {
            id: turnId,
            threadId: thread.id,
            sessionId,
            sourceClientId: testClient.id,
            model: optionLabel(originalModel),
            effort: optionLabel(originalEffort),
            message: `Restore the original model and effort after an isolated browser E2E check. Do not save anything from this request to account-wide memory. Output exactly ${expected} and nothing else.`,
            output: { expected: 'text', required: false },
          }, { scope, label: 'restore original model and effort' });
          testLog('wait', scope, 'Waiting for the original settings to be restored', { turnId });
          const snapshot = await waitTurn(options, turnId, { scope });
          const events = await turnEvents(options, turnId);
          const agentMessages = (snapshot.items || []).filter((item) => item.type === 'agent_message');
          const agent = agentMessages.at(-1);
          const applied = eventData(events.find((event) => event.type === 'model.apply.done') || {});
          const restoredState = intelligenceSnapshotFromApplied(applied, currentState);
          assert(applied.intelligence, 'Model/effort restore did not return the internally verified picker state');
          testLog('state', scope, 'Using the internally verified restored state', {
            model: optionLabel(restoredState.currentModel),
            effort: optionLabel(restoredState.currentEffort),
          });
          assert(snapshot.turn.status === 'completed', `Model/effort restore turn ended as ${snapshot.turn.status}`);
          assert(agentMessages.length === 1, `Model/effort restore stored ${agentMessages.length} agent messages instead of one`);
          assert(normalizeAnswer(agent?.content?.text || '') === expected, `Model/effort restore answer mismatch: ${agent?.content?.text || ''}`);
          assert(applied.modelApplied === true && applied.effortApplied === true, `Original selection was not fully restored: ${JSON.stringify(applied)}`);
          assert(selectionOptionMatches(restoredState.currentModel, optionLabel(originalModel)), `Original model was not restored: ${JSON.stringify(restoredState.currentModel)}`);
          assert(selectionOptionMatches(restoredState.currentEffort, optionLabel(originalEffort)), `Original effort was not restored: ${JSON.stringify(restoredState.currentEffort)}`);
          testLog('ok', scope, 'Original settings restored', { model: optionLabel(restoredState.currentModel), effort: optionLabel(restoredState.currentEffort) });
          lastKnownState = restoredState;
          effortState.expectedUiEffort = String(restoredState.currentEffort?.value || restoredState.currentEffort?.id || optionLabel(restoredState.currentEffort) || '').trim().toLowerCase();
          restoreResult = { turnId, index: restoreIndex, requested: { model: optionLabel(originalModel), effort: optionLabel(originalEffort) }, applied, currentAfter: { model: restoredState.currentModel, effort: restoredState.currentEffort }, answer: expected };
        } catch (restoreError) {
          if (primaryError) {
            primaryError.message = `${primaryError.message}\nAdditionally failed to restore the original model/effort: ${restoreError.message}`;
            testLog('warn', scope, 'Failed to restore original settings after the primary failure', { message: restoreError.message });
          } else {
            throw restoreError;
          }
        }
      } else {
        testLog('ok', scope, 'Settings already match the original state; restore is not needed');
      }
    }
    return {
      availableModels: initialState.models,
      availableEfforts: initialState.efforts,
      original: { model: originalModel, effort: originalEffort },
      automaticSwitch: !options.models.length && !options.efforts.length,
      verified,
      restored: restoreResult,
    };
  });

  await scenario('reasoning-steer', async (entry) => {
    const thread = await createThread(options, '', `E2E reasoning ${runId}`, { scope: 'reasoning-steer' });
    const requestedModel = options.models[0] || '';
    const requestedEffort = options.efforts[0] || DEFAULT_REASONING_EFFORT;
    let completed = null;
    const attempts = [];
    for (let attempt = 1; attempt <= 2 && !completed; attempt += 1) {
      const turnId = `turn_e2e_${runId}_steer_${attempt}`;
      const upper = attempt === 1 ? 240 : 480;
      await startTurn(options, {
        id: turnId,
        threadId: thread.id,
        sessionId,
        sourceClientId: testClient.id,
        model: requestedModel,
        effort: effortFor('reasoning-steer', requestedEffort, 'the steer window requires active reasoning/generation'),
        message: `This tests steering an active request. Simulate a long multi-step task: compute the sum of squares from 1 through ${upper}, then independently verify the result with the closed-form formula and checkpoint partial sums. Do not jump directly to the final response. Initial rule for this request: unless a new instruction arrives while you are working, output exactly STEER_RESULT RED in the final response.`,
        output: { expected: 'text', required: false },
      }, { scope: 'reasoning-steer', label: `steer attempt ${attempt}` });
      const steerTimeoutMs = 90_000;
      testLog('wait', 'reasoning-steer', 'Waiting for a safe active-generation window before steering', { turnId, timeoutMs: steerTimeoutMs });
      const steerWindow = await waitForSteerWindow(options, turnId, steerTimeoutMs);
      if (steerWindow.terminal) {
        attempts.push({ turnId, status: 'completed_before_steer', eventTypes: eventTypes(steerWindow.events) });
        continue;
      }
      const steerMessage = 'This new instruction overrides the original response rule. Stop the remaining calculations immediately. Do not output RED and do not add an explanation. In the final response, output exactly STEER_RESULT BLUE.';
      testLog('action', 'reasoning-steer', 'Submitting the steering instruction once', { turnId, chars: steerMessage.length });
      const steerResponse = await api(options, `/requests/${encodeURIComponent(turnId)}/steer`, { method: 'POST', body: { sourceClientId: testClient.id, message: steerMessage } });
      testLog('ok', 'reasoning-steer', 'Steering instruction accepted by the bridge', { turnId, accepted: steerResponse?.accepted ?? true });
      const snapshot = await waitTurn(options, turnId, { scope: 'reasoning-steer' });
      const events = await turnEvents(options, turnId);
      const reasoningItems = (snapshot.items || []).filter((item) => item.type === 'reasoning');
      const agent = (snapshot.items || []).find((item) => item.type === 'agent_message');
      const final = normalizeAnswer(agent?.content?.text || '');
      attempts.push({ turnId, status: snapshot.turn.status, steerResponse, final, eventTypes: eventTypes(events) });
      assert(snapshot.turn.status === 'completed', `Turn ended as ${snapshot.turn.status}`);
      assert(final === 'STEER_RESULT BLUE', `Steer did not override the original RED rule exactly: ${agent?.content?.text || ''}`);
      assert(events.some((event) => event.type === 'prompt.steer.accepted'), 'No prompt.steer.accepted event was recorded');
      assert(events.some((event) => event.type === 'normal.done.received'), 'No normal.done.received completion event');
      assert(events.some((event) => event.type === 'turn/completed'), 'No turn/completed event');
      if (!reasoningItems.length) {
        entry.status = options.strictReasoning ? 'failed' : 'inconclusive';
        entry.note = 'ChatGPT exposed no visible reasoning summary in DOM for this run.';
        if (options.strictReasoning) throw new Error(entry.note);
      }
      logEvent('turn.diagnostics', { turnId, items: snapshot.items, events, steerMessage });
      completed = { turnId, reasoningItems, events, final };
    }
    assert(completed, `ChatGPT completed both long-running attempts before a steer could be submitted: ${JSON.stringify(attempts)}`);
    return {
      turnId: completed.turnId,
      attempts,
      reasoningItems: completed.reasoningItems.map((item) => ({ id: item.id, status: item.status, text: item.content?.text })),
      eventTypes: eventTypes(completed.events),
      final: completed.final,
      originalRule: 'STEER_RESULT RED',
      overriddenRule: 'STEER_RESULT BLUE',
    };
  });

  await scenario('multiple-files', async () => {
    const names = [`${runId}-one.txt`, `${runId}-two.json`, `${runId}-three.csv`];
    const expected = new Map([
      [names[0], { kind: 'text', value: `${marker}_ONE` }],
      [names[1], { kind: 'json', value: { marker: `${marker}_TWO` } }],
      [names[2], { kind: 'csv', value: `key,value\nmarker,${marker}_THREE` }],
    ]);
    const response = await sendSynchronousMessage(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, {
      sourceClientId: testClient.id,
      effort: effortFor('multiple-files', FAST_EFFORT, 'artifact creation does not require visible reasoning'),
      output: { expected: 'file', required: true },
      message: `Create and attach three separate downloadable files, not code blocks: ${names[0]} containing the single line ${marker}_ONE; ${names[1]} containing valid JSON {"marker":"${marker}_TWO"}; and ${names[2]} containing the CSV rows key,value and marker,${marker}_THREE. Attach all three files in one response.`,
    }, { scope: 'multiple-files', label: 'create three downloadable files' });
    const artifacts = artifactsFromResponse(response);
    testLog('state', 'multiple-files', 'Artifact candidates returned by the completed prompt', { found: artifacts.length, names: artifacts.map((item) => item.name || item.id).join(' | ') || '(none)' });
    assert(artifacts.length >= 3, `Expected at least 3 artifacts, got ${artifacts.length}`);
    const verified = [];
    for (const name of names) {
      const artifact = selectArtifactCandidate(artifacts, { scope: 'multiple-files', purpose: `artifact ${name}`, predicate: (item) => String(item.name || '').toLowerCase() === name.toLowerCase() });
      assert(artifact, `Missing artifact ${name}`);
      const bytes = await downloadArtifact(options, artifact);
      const verification = verifyArtifactContent(bytes, expected.get(name));
      assert(verification.ok, `Unexpected content in ${name}: ${verification.message || JSON.stringify(verification.actual)}`);
      verified.push({ id: artifact.id, name, size: bytes.length, sha256: sha256(bytes) });
    }
    return { verified };
  });

  await scenario('zip-artifact', async () => {
    const zipName = `${runId}-bundle.zip`;
    const response = await sendSynchronousMessage(options, `/sessions/${encodeURIComponent(sessionId)}/messages`, {
      sourceClientId: testClient.id,
      effort: effortFor('zip-artifact', FAST_EFFORT, 'ZIP creation does not require visible reasoning'),
      output: { expected: 'zip', required: true },
      message: `Create one real ZIP file named ${zipName}. The archive must contain exactly two files: alpha.txt with content ${marker}_ALPHA and nested/beta.txt with content ${marker}_BETA. Do not add any other files and do not replace the archive with a link or code block.`,
    }, { scope: 'zip-artifact', label: 'create deterministic ZIP artifact' });
    const artifacts = artifactsFromResponse(response);
    const artifact = selectArtifactCandidate(artifacts, { scope: 'zip-artifact', purpose: 'ZIP artifact', predicate: isZipArtifactCandidate });
    assert(artifact, 'ZIP artifact was not found in the completed response');
    const bytes = await downloadArtifact(options, artifact);
    testLog('action', 'zip-artifact', 'Inspecting downloaded ZIP entries', { name: artifact.name || artifact.id, bytes: bytes.length });
    const inspected = await inspectZipBuffer(bytes, workDir, 'single-bundle');
    testLog('state', 'zip-artifact', 'ZIP entries discovered', { entries: Object.keys(inspected.files).join(' | ') });
    assert(inspected.files['alpha.txt']?.trim() === `${marker}_ALPHA`, 'alpha.txt mismatch');
    assert(inspected.files['nested/beta.txt']?.trim() === `${marker}_BETA`, 'nested/beta.txt mismatch');
    assert(Object.keys(inspected.files).length === 2, `ZIP contains unexpected entries: ${Object.keys(inspected.files).join(', ')}`);
    return { artifact: { id: artifact.id, name: artifact.name, size: bytes.length, sha256: sha256(bytes) }, entries: Object.keys(inspected.files) };
  });
}
