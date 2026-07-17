# Workflow UX Test Coverage

The workflow redesign has a dedicated coverage gate in addition to the project's full test suite.

Run it with:

```bash
npm run test:workflow:coverage
```

The command covers the workflow UX, attention and notification services, result protocol, shared workflow services, and chat bootstrap modules. It fails when coverage drops below:

- 90% line coverage
- 60% branch coverage
- 80% function coverage

## Requirement Coverage

| Area | Primary tests |
| --- | --- |
| `/workflow` context-sensitive entry point and five-step setup | `test/workflowWizardCoverage.test.js` |
| Three presets, project selection, chat selection, and check selection | `test/workflowWizardCoverage.test.js`, `test/workflowUxConfigCoverage.test.js` |
| First-run defaults, validation, profiles, and per-workflow overrides | `test/workflowUxConfigCoverage.test.js`, `test/workflowUxCompletion.test.js` |
| Attention states and portable notifications | `test/workflowUxConfigCoverage.test.js`, `test/workflowUxCompletion.test.js` |
| New-chat bootstrap, handoff, turn limits, and session recovery policies | `test/workflowServicesCoverage.test.js`, `test/workflowUxCompletion.test.js` |
| Project context fingerprinting and refresh | `test/workflowContextSync.test.js`, `test/workflowServicesCoverage.test.js` |
| Result manifest validation, exact file allow-list, and automatic repair | `test/workflowResultProtocol.test.js`, `test/workflowUxCompletion.test.js`, `test/workflowServicesCoverage.test.js` |
| Safe application, remediation, commit approval, and terminal failures | `test/workflowApplyVerifiedCoverage.test.js`, `test/workflowUxCompletion.test.js` |
| Workflow-owned commits, user-edit races, checkpoints, and squash | `test/workflowCommitPolicy.test.js`, `test/workflowUxCompletion.test.js` |
| Apply Changes failed-check decisions | `test/workflowUxCompletion.test.js`, `test/workflowWizardCoverage.test.js` |
| Fix Until Checks Pass lifecycle and no-progress handling | `test/workflowAutomation.test.js`, `test/workflowWizardCoverage.test.js` |
| Guided Task actions and return to interactive mode | `test/workflowWizardCoverage.test.js` |
| Plain-language status, history, and decision rendering | `test/workflowViewCoverage.test.js`, `test/workflowUx.test.js` |
| Independent workflow worker and local captured-DOM integration | `test/workflowMultiBridge.integration.test.js`, `test/capturedDomFixtures.test.js` |
| Wizard Space toggles, backward navigation, setup retry, command completion, and Apply Changes live transcript | `test/workflowWizardCoverage.test.js`, `test/interactiveTerlioInput.test.js`, `test/browserClientSelection.test.js`, `test/pageRuntimeObservers.test.js`, `test/applyWorkflowLiveMonitor.test.js` |

## Browser Release Verification

The repository contains real-browser workflow scenarios for bootstrap, approvals, remediation, passive watching, and multiple Bridge instances. They require an authenticated ChatGPT browser profile and remain release-environment tests rather than deterministic CI tests.

Run the complete authenticated workflow scenario set with:

```bash
npm run test:e2e:workflows
```
