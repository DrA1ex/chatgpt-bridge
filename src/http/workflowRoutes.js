import { HttpError } from '../httpError.js';

function requireWorkflowManager(workflowManager) {
  if (!workflowManager) throw new HttpError(503, 'Workflow manager is not configured');
  return workflowManager;
}

/** The v3 workflow HTTP surface intentionally exposes one snapshot and one command path. */
export function registerWorkflowRoutes(router, workflowManager) {
  router.get('/workflows', async (_req, res, next) => {
    try { res.json({ ok: true, workflows: requireWorkflowManager(workflowManager).list() }); } catch (error) { next(error); }
  });

  router.get('/workflows/:id', async (req, res, next) => {
    try {
      const workflow = requireWorkflowManager(workflowManager).get(req.params.id);
      if (!workflow) throw new HttpError(404, `Unknown workflow: ${req.params.id}`);
      res.json({ ok: true, workflow });
    } catch (error) { next(error); }
  });

  router.post('/workflows/load', async (req, res, next) => {
    try {
      const configPath = String(req.body?.configPath || req.body?.path || '').trim();
      if (!configPath) throw new HttpError(400, 'configPath is required');
      res.json({ ok: true, workflow: await requireWorkflowManager(workflowManager).load(configPath, { start: req.body?.start !== false }) });
    } catch (error) { next(error); }
  });

  router.post('/workflows/:id/commands', async (req, res, next) => {
    try {
      const command = req.body && typeof req.body === 'object' ? req.body : {};
      const type = String(command.type || command.command || '').trim();
      if (!type) throw new HttpError(400, 'command type is required');
      if (!String(command.commandId || '').trim()) throw new HttpError(400, 'commandId is required');
      if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) throw new HttpError(400, 'expectedRevision must be a non-negative integer');
      const result = await requireWorkflowManager(workflowManager).command(req.params.id, command);
      res.status(['run', 'resume', 'retry'].includes(type) ? 202 : 200).json({ ok: true, workflow: result });
    } catch (error) { next(error); }
  });

  router.delete('/workflows/:id', async (req, res, next) => {
    try { res.json({ ok: await requireWorkflowManager(workflowManager).unload(req.params.id) }); } catch (error) { next(error); }
  });

  router.get('/workflows/:id/events', async (req, res, next) => {
    try { res.json({ ok: true, events: await requireWorkflowManager(workflowManager).events(req.params.id, req.query.limit) }); } catch (error) { next(error); }
  });

  router.get('/workflows/:id/transitions', async (req, res, next) => {
    try {
      const manager = requireWorkflowManager(workflowManager);
      if (!manager.get(req.params.id)) throw new HttpError(404, `Unknown workflow: ${req.params.id}`);
      res.json({ ok: true, transitions: await manager.store.listTransitions({ workflowId: req.params.id, limit: req.query.limit }) });
    } catch (error) { next(error); }
  });
}
