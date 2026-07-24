import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import healthRoutes from './routes/health';
import runRoutes from './routes/runs';
import eventRoutes from './routes/events';
import logRoutes from './routes/logs';
import analyticsRoutes from './routes/analytics';
import reviewRoutes from './routes/review';
import decisionRoutes from './routes/decisions';
import identityRoutes from './routes/identity';
import reportRoutes from './routes/reports';
import knowledgeReviewRoutes from './routes/knowledgeReviews';
import { globalWatcher } from './services/watcher';
import { globalScanner } from './services/runScanner';
import { createAuthMiddleware } from './middleware/auth';
import { mountIntakeRoutes } from './routes/intake';
import { mountLocalRoutes } from './routes/local';
import { buildReviewRouter } from './routes/intake/review';
import { makeInProcessReviewBackend } from './local/reviewBackend';
import { intakeConfig } from './intake/config';
import { getDb } from './intake/db';

const app = express();

app.use(cors({ origin: config.allowedOrigins }));
app.use(express.json());

// Health stays open so uptime probes don't need the token.
app.use('/api/health', healthRoutes);

// Intake Board (Central): tester surface uses its own session auth, NOT the
// shared bearer token — mount before the /api bearer guard so it is not shadowed.
mountIntakeRoutes(app, {
  allowedOrigins: config.allowedOrigins,
  adminToken: config.authToken,
});

// Local admin routes (refresh/claim/triage-package/triage-result/promote):
// mounted only when this instance's deployment role includes 'local'. Reaches
// Central exclusively via makeCentralClient (Decision #1) — never opens
// Central SQLite directly.
if (intakeConfig.intakeRole === 'local' || intakeConfig.intakeRole === 'both') {
  mountLocalRoutes(app, config.authToken, { taskPrefix: process.env.OFFICE_TASK_PREFIX });
}

// Everything below requires the shared token (when DASHBOARD_AUTH_TOKEN is set).
app.use('/api', createAuthMiddleware(config.authToken));
app.use('/api/intake/review', buildReviewRouter(
  makeInProcessReviewBackend(getDb(), { runsDir: intakeConfig.runsDir, officeRoot: config.aiOfficeRoot })
));
app.use('/api/runs', runRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/decisions', decisionRoutes);
app.use('/api/identity', identityRoutes);
app.use('/api/knowledge-reviews', knowledgeReviewRoutes);

// Serve the built client (both entries: admin `index.html`, tester
// `intake.html`) same-origin, so `/intake` works without a separate Vite
// dev server or its own CORS/proxy setup. [PLAN-ASSUMPTION]: guarded on the
// dist dir existing — in dev the dist hasn't been built, so this is a no-op
// and the Vite dev server (port 3000) serves both pages instead.
const intakeHtmlPath = path.join(config.clientDistDir, 'intake.html');
if (fs.existsSync(config.clientDistDir)) {
  app.use(express.static(config.clientDistDir));
  app.get('/intake', (_req, res) => {
    if (fs.existsSync(intakeHtmlPath)) {
      res.sendFile(intakeHtmlPath);
    } else {
      res.status(404).send('intake.html not found in client build output');
    }
  });
} else {
  console.log(`Client dist dir not found at ${config.clientDistDir} — skipping static serving (dev mode expected).`);
}

// Each SSE client subscribes one 'update' listener; with the persistent
// invalidate listener below, the default cap of 10 would warn under a handful
// of concurrent viewers. Lift it (0 = unlimited).
globalWatcher.setMaxListeners(0);

// Start Watcher and drop the scanner cache whenever runs change, so the next
// request (and SSE-driven refresh) sees fresh data instead of a stale snapshot.
globalWatcher.on('update', () => globalScanner.invalidate());
globalWatcher.start();

app.listen(config.port, () => {
  console.log(`AI Dashboard Server running on http://localhost:${config.port}`);
  console.log(`Watching runs in: ${config.runsDir}`);
  getDb();
  console.log('Intake SQLite ready');
  if (!config.authToken) {
    console.warn(
      'WARNING: DASHBOARD_AUTH_TOKEN is not set — API auth is DISABLED. ' +
        'Set it before exposing the dashboard beyond localhost.'
    );
  }
});
