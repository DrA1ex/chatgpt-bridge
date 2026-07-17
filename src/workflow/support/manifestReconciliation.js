import { reconcileResultManifestAgainstPlan } from '../result/resultProtocol.js';

export async function recordManifestReconciliation({ verification, plan, publish, metadata = {} } = {}) {
  const reconciliation = reconcileResultManifestAgainstPlan({
    manifest: verification?.resultProtocol?.manifest,
    plan,
  });
  verification.resultProtocol = {
    ...(verification.resultProtocol || {}),
    reconciliation,
  };
  await publish?.({
    ...metadata,
    fileListProvided: reconciliation.fileListProvided,
    actualChangedFiles: reconciliation.actualFiles,
    ignoredUnchangedFiles: reconciliation.ignoredUnchangedFiles,
    undeclaredChangedFiles: reconciliation.undeclaredChangedFiles,
  });
  return reconciliation;
}
