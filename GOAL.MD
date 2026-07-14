# Current Engineering Goals

## Primary goal

Make browser automation deterministic: every browser fact becomes a revisioned observation, every request-scoped action becomes a typed effect, and every request decision is made by one canonical reducer.

The runtime migration is complete. Current work is structural decomposition and live-browser hardening.

## Reliability goals

- Fail immediately on explicit request-owned terminal errors.
- Never wait for a timeout after an incompatible terminal revision is already committed.
- Use deadlines only to detect absent progress, lost liveness, reconnect failure, or artifact materialization failure.
- Preserve final answer, reasoning phases, ordered response blocks, artifacts, and source identity without reconstructing them from log text.
- Keep stale observations, duplicate messages, and restarted observer epochs deterministic.
- Bind every follow-up, recovery, artifact action, and release to the correct source tab.
- Treat required ZIP output as a separate contract from text completion.

## Architecture goals

- Maintain protocol 3 as the only extension contract.
- Keep the extension as observer/effect executor and the server as decision owner.
- Keep all production source files under 1,000 lines and target 500 lines.
- Keep the completed `content.js` and `domParserCore.js` decomposition stable, and finish splitting `e2e-real.js` by cohesive domain boundaries.
- Add replay fixtures for recurring live failures.
- Keep workflow watcher and pipeline state independent and atomically persisted.

## Product goals

- Provide stable HTTP, OpenAI-compatible, RPC, workflow, and Ink interfaces.
- Make tab selection and automatic tab opening explicit and diagnosable.
- Preserve safe project ZIP validation and apply behavior.
- Produce useful compact/full diagnostic bundles without exposing secrets.
- Keep real E2E scenarios deterministic, isolated, and able to save diagnostics before assertions.

## Non-goals

- alternate browser transports;
- protocol downgrade support;
- multiple request state machines;
- page-context localhost transport;
- hidden CLI fallback runtimes;
- unbounded waits;
- automatic application of ambiguous or stale artifacts;
- arbitrary file splitting that creates circular dependencies.

## Near-term plan

1. Split `e2e-real.js` into environment, session, scenarios, assertions, and diagnostics modules while preserving the current scenario CLI.
2. Run the complete live E2E suite with extension 1.x/content 3.x after reloading the unpacked extension.
3. Convert every new recurring failure into a sanitized replay test.
4. Keep `content.js` as a thin facade and prevent domain logic from drifting back out of the extracted `content/` modules.
5. Keep artifact parsing isolated from general turn/lifecycle classification.
