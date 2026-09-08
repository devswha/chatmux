import express from 'express';
import type { RequestHandler } from 'express';

import { authorizeFleetBrowserRequest } from '@/modules/fleet/index.js';

import type { OwnerDiagnostics, OwnerPaneDiagnostics } from '../../../shared/diagnostics.js';

export function createDiagnosticsRouter(dependencies: {
  authMode: 'none' | 'password' | 'tailscale';
  authenticate: RequestHandler;
  read: () => OwnerDiagnostics;
  readPanes: () => OwnerPaneDiagnostics;
}): express.Router {
  const router = express.Router();
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.use(dependencies.authenticate);
  router.all("/panes", (request, response) => {
    // Express otherwise dispatches HEAD to GET and supplies automatic OPTIONS.
    if (request.method !== "GET") {
      response.status(404).end();
      return;
    }
    const owner = authorizeFleetBrowserRequest(request, dependencies.authMode);
    if (!("user" in request) || !request.user) {
      response.status(401).json({ error: "authentication_required" });
      return;
    }
    if (!owner) {
      response.status(403).json({ error: "owner_required" });
      return;
    }
    try {
      response.json(dependencies.readPanes());
    } catch {
      response.status(503).json({ error: "diagnostics_unavailable" });
    }
  });
  router.get('/', (request, response) => {
    const owner = authorizeFleetBrowserRequest(request, dependencies.authMode);
    if (!('user' in request) || !request.user) {
      response.status(401).json({ error: 'authentication_required' });
      return;
    }
    if (!owner) {
      response.status(403).json({ error: 'owner_required' });
      return;
    }
    try {
      response.json(dependencies.read());
    } catch {
      response.status(503).json({ error: 'diagnostics_unavailable' });
    }
  });
  return router;
}
