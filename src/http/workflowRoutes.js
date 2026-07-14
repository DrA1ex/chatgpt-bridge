import { HttpError } from '../httpError.js';

function requireWorkflowManager(workflowManager) {
  if (!workflowManager) throw new HttpError(503, 'Workflow manager is not configured');
  return workflowManager;
}

export function registerWorkflowRoutes(router, workflowManager) {
  router.get('/workflows', async (_req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, workflows: manager.list(), approvals: await manager.approvals() });
    } catch (err) { next(err); }
  });

  router.get('/workflows/:id', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      const workflow = manager.get(req.params.id);
      if (!workflow) throw new HttpError(404, `Unknown workflow: ${req.params.id}`);
      res.json({ ok: true, workflow });
    } catch (err) { next(err); }
  });

  router.post('/workflows/load', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      const configPath = String(req.body?.configPath || req.body?.path || '').trim();
      if (!configPath) throw new HttpError(400, 'configPath is required');
      res.json({ ok: true, workflow: await manager.load(configPath, { start: req.body?.start !== false }) });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/start', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, workflow: await manager.start(req.params.id) });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/stop', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, workflow: await manager.stop(req.params.id) });
    } catch (err) { next(err); }
  });

  router.delete('/workflows/:id', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: await manager.unload(req.params.id) });
    } catch (err) { next(err); }
  });

  router.get('/workflows/:id/events', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, events: await manager.events(req.params.id, req.query.limit) });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/verify', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, verification: await manager.verifyArtifact(req.params.id, {
        artifactId: String(req.body?.artifactId || ''),
        fileId: String(req.body?.fileId || ''),
      }) });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/extension/deploy', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, result: await manager.deployExtension(req.params.id) });
    } catch (err) { next(err); }
  });

  router.get('/workflow-approvals', async (_req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, approvals: await manager.approvals() });
    } catch (err) { next(err); }
  });

  router.post('/workflow-approvals/:id/approve', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, result: await manager.approve(req.params.id) });
    } catch (err) { next(err); }
  });

  router.post('/workflow-approvals/:id/reject', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      const reason = String(req.body?.reason || 'rejected by API');
      res.json({ ok: true, approval: await manager.reject(req.params.id, reason) });
    } catch (err) { next(err); }
  });
}
