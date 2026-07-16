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

  router.post('/workflows/:id/run', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      const automation = await manager.runAutomation(req.params.id, {
        maxCycles: Number(req.body?.maxCycles) || undefined,
        verbose: Boolean(req.body?.verbose),
        resetThread: Boolean(req.body?.resetThread),
        sessionId: String(req.body?.sessionId || ''),
        sessionPolicy: String(req.body?.sessionPolicy || ''),
        sourceClientId: String(req.body?.sourceClientId || ''),
        model: String(req.body?.model || ''),
        effort: String(req.body?.effort || ''),
        trigger: 'http',
      });
      res.status(202).json({ ok: true, automation });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/run/stop', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      const automation = await manager.stopAutomation(req.params.id, String(req.body?.reason || 'stopped by API'));
      res.json({ ok: true, automation });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/run/restart', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      const automation = await manager.restartAutomation(req.params.id, {
        maxCycles: Number(req.body?.maxCycles) || undefined,
        verbose: Boolean(req.body?.verbose),
        sessionId: String(req.body?.sessionId || ''),
        sessionPolicy: String(req.body?.sessionPolicy || ''),
        sourceClientId: String(req.body?.sourceClientId || ''),
        model: String(req.body?.model || ''),
        effort: String(req.body?.effort || ''),
        trigger: 'http',
      });
      res.status(202).json({ ok: true, automation });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/run/resume', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.status(202).json({ ok: true, automation: await manager.resumeAutomation(req.params.id) });
    } catch (err) { next(err); }
  });

  router.post('/workflows/:id/run/discard', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, automation: await manager.discardAutomation(req.params.id, String(req.body?.reason || 'discarded by API')) });
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

  router.post('/workflows/:id/process-file', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      res.json({ ok: true, result: await manager.processFileResult(req.params.id, {
        fileId: String(req.body?.fileId || ''),
        answer: String(req.body?.answer || ''),
        turnId: String(req.body?.turnId || ''),
        turnKey: String(req.body?.turnKey || ''),
        sessionId: String(req.body?.sessionId || ''),
        sourceClientId: String(req.body?.sourceClientId || ''),
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
