# Workflow UX Open Questions

The `/workflow` redesign is implemented against the current workflow engine. The items below are intentionally not hidden as completed requirements. They need a separate design and rollout plan because the correct behavior depends on product policy or an authenticated release environment rather than on another local code path.

## Ambiguous legacy workflow migration

Bridge now maps legacy definitions when their intent is deterministic:

- An enabled advanced preset with check steps maps to **Fix until checks pass**.
- A guided-focused definition maps to **Work through a task**.
- A passive-observation preset maps to **Apply changes from ChatGPT** for display and management purposes without enabling the new result-repair defaults implicitly.

Custom legacy definitions can combine passive-observation options, extension deployment, daemon restart, custom output protocols, or external workers in ways that do not have a safe one-to-one preset mapping. A migration plan must decide whether these definitions should remain advanced workflows, require an explicit user choice, or support a generated custom profile.

## Stale-context classification

Bridge currently recovers a chat when ChatGPT reports an exhaustion/unusable-conversation error or when the configured workflow-turn limit is reached. Those signals are deterministic.

The remaining question is how to classify repeated failures as being caused specifically by stale conversational context rather than by a difficult task, a bad result package, or unchanged test failures. A separate plan should define the evidence, threshold, false-positive safeguards, and whether recovery is automatic or first presented as a user decision.

## Authenticated real-browser release matrix

The repository contains the real-browser workflow harness and local mock/integration coverage for the new services and user states. Completing a release certification run still requires an authenticated ChatGPT browser profile and supported desktop environments.

A separate verification plan should define the required browser/OS matrix, retained diagnostics, retry policy, and release-blocking criteria for all three presets with current/new chats, repair exhaustion, project refresh, session recovery, commit policies, squash, and pause/resume/stop.
