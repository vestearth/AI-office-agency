import type { RequestHandler } from 'express';
import { config } from '../config';

// Executing a local agent is stronger than a read model. Reject remote callers,
// DNS rebinding, and cross-origin writes even when dashboard auth is disabled.
export const localOnly: RequestHandler = (req, res, next) => {
  const peer = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer || '') || !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) {
    return res.status(403).json({ error: 'CLI execution is available only on localhost.' });
  }
  if (req.method === 'POST' && ![...config.allowedOrigins, `http://localhost:${config.port}`].includes(req.get('origin') || '')) {
    return res.status(403).json({ error: 'CLI writes require an allowed dashboard Origin.' });
  }
  next();
};
