import express from 'express';
import cors from 'cors';
import { config } from './config';
import healthRoutes from './routes/health';
import runRoutes from './routes/runs';
import eventRoutes from './routes/events';
import logRoutes from './routes/logs';
import analyticsRoutes from './routes/analytics';
import reviewRoutes from './routes/review';
import decisionRoutes from './routes/decisions';
import identityRoutes from './routes/identity';
import { globalWatcher } from './services/watcher';
import { globalScanner } from './services/runScanner';
import { createAuthMiddleware } from './middleware/auth';

const app = express();

app.use(cors({ origin: config.allowedOrigins }));
app.use(express.json());

// Health stays open so uptime probes don't need the token.
app.use('/api/health', healthRoutes);

// Everything below requires the shared token (when DASHBOARD_AUTH_TOKEN is set).
app.use('/api', createAuthMiddleware(config.authToken));
app.use('/api/runs', runRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/decisions', decisionRoutes);
app.use('/api/identity', identityRoutes);

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
  if (!config.authToken) {
    console.warn(
      'WARNING: DASHBOARD_AUTH_TOKEN is not set — API auth is DISABLED. ' +
        'Set it before exposing the dashboard beyond localhost.'
    );
  }
});
