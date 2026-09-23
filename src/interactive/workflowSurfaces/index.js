export {
  renderGenericWorkflowSurface,
  renderWorkflowAction,
  renderWorkflowSection,
} from './generic.js';
export {
  renderFileDetails,
  renderFileGroups,
  renderPlanSummary,
  renderWorkflowPlanPage,
} from './plan.js';
export {
  renderCheckResults,
  renderProgress,
} from './progress.js';
export {
  renderChoiceList,
  renderCommit,
  renderDeployment,
  renderSummaryFields,
} from './setup.js';
export {
  renderHistoryRows,
  renderRunDetails,
  renderWorkflowHistoryPage,
} from './history.js';
export {
  renderSideBySideDiff,
  renderUnifiedDiff,
  renderWorkflowDiff,
} from './diff.js';
export {
  literalWorkflowText,
  publicWorkflowText,
} from './text.js';

import { renderGenericWorkflowSurface } from './generic.js';

export function renderWorkflowSurface(surface = {}) {
  return renderGenericWorkflowSurface(surface);
}
