import express from 'express';
import { config } from './config.js';
import { createRouter } from './routes.js';

export function createApp(bridge, fileStore, eventBus = null, jobManager = null, turnManager = null, projectService = null, workflowManager = null) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(createRouter(bridge, fileStore, eventBus, jobManager, turnManager, projectService, workflowManager));

  return app;
}
