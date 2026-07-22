# Deterministic Local ChatGPT E2E Runtime

## Purpose

The local E2E runtime executes the same registered E2E scenarios and the same Bridge HTTP, request, workflow, artifact, release, quarantine, and Protocol 5 paths as the authenticated browser runner, but replaces the external ChatGPT product and Chrome extension runtime with a deterministic local participant.

It is not a second request lifecycle. The server still owns canonical request meaning, the mock extension publishes immutable `TabObservation` records, effect-backed commands settle through BrowserEffect envelopes, and release still settles through `lease.released`.

## Components

- `scripts/e2e/mock-chatgpt/state-machine.js` owns deterministic conversations, turns, reasoning checkpoints, steering, artifacts, model/effort state, and session navigation.
- `scripts/e2e/mock-chatgpt/render.js` renders a ChatGPT-shaped page with the composer, attachment chips and file input, assistant/user turns, CodeMirror-shaped code blocks, reasoning containers, artifact cards and preview dialogs, intelligence menus, sidebar session menus, and delete confirmation dialog.
- `scripts/e2e/mock-chatgpt/extension-client.js` is a Protocol 5 extension participant. It consumes the shared command manifest and publishes the same typed command/effect/lease/observation envelopes as the real extension.
- `scripts/e2e/mock-chatgpt/server.js` serves the layout, artifact bytes, state snapshots, and deterministic UI actions.
- `scripts/e2e/mock-chatgpt/contract.js` is the executable parity boundary. Tests fail when a shared command is added without local E2E support.

The local coverage is intentionally split into two layers instead of running a second hidden browser lifecycle:

1. the mock Protocol 5 participant drives the real Bridge request, reducer, workflow, transport, artifact, release, and quarantine paths;
2. the rendered HTML is replayed through the production offline DOM parser and selector contracts.

This keeps canonical lifecycle ownership in Bridge while still detecting malformed ChatGPT-shaped markup. Platform behavior that cannot be represented faithfully without Chrome remains in the live-only boundary below.

## Commands

Run the complete registered E2E matrix locally:

```bash
npm run test:e2e:local
```

Run only the Protocol 5 scenario matrix, without the fixture preflight:

```bash
npm run test:e2e:mock
```

Run focused groups:

```bash
npm run test:e2e:local:core
npm run test:e2e:local:workflows
npm run test:e2e:local:fixtures
```

Run one scenario through the normal runner:

```bash
node scripts/e2e-real.js --mock-chatgpt --scenario reload-mid-request
node scripts/e2e-real.js --mock-chatgpt --scenario workflow-remediation
```

Start only the visual fixture/state-machine server:

```bash
npm run mock:chatgpt
```

The command prints a local URL. The composer, attachment chips, session list, model/effort controls, stop button, artifact preview/download controls, and delete confirmation are interactive. State is also available through `GET /api/tabs/1`; deterministic actions use `POST /api/tabs/1`. The POST surface accepts prompt/steer/cancel, session, intelligence, and attachment-state actions so a regression fixture can move the page to a precise UI state without a ChatGPT account.

## Covered contracts

The local matrix covers:

- owned-conversation bootstrap and exact-answer continuity;
- Markdown, inline-code, fenced-code, CodeMirror-shaped markup, and parser ownership audit;
- reasoning revisions and ordered 0–100% public progress;
- model and effort selection;
- steering and response-epoch transition;
- tab/content reload during an active request;
- quarantine isolation across two owned tabs;
- composer attachment preparation/removal, separate downloadable files, artifact preview DOM, and deterministic ZIP materialization;
- passive workflow ingestion, approval, rollback/remediation, and apply;
- primary/worker observed-turn transport;
- project context, multi-turn project updates, and no-context fallback;
- session create/select/delete, layout capture, and release cleanup.

## Live-only boundary

Authenticated E2E remains required for platform/product compatibility rather than canonical lifecycle coverage:

- Chrome extension installation, permissions, service-worker suspension, and unpacked-extension reload behavior;
- current authenticated ChatGPT DOM/selector drift and product dialogs;
- native Chrome download-manager correlation and download shelf behavior;
- real model latency, account limits, and server-side generation behavior.

A live failure caused by a new DOM variant should be captured as a sanitized fixture or represented in the deterministic state machine before the production adapter fix is accepted.

## Adding a command or scenario

When adding a command:

1. add it to the shared command manifest;
2. add its deterministic implementation to the mock extension participant;
3. add it to `LOCAL_E2E_COMMAND_TYPES`;
4. add a scenario or fault-boundary assertion proving its result and recovery behavior.

When adding a scenario, register it once in `scripts/e2e-scenarios.js`. The default local and live runners both select the same complete registry. Do not create a local-only simplified scenario with weaker assertions.
