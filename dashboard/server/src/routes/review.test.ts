import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'net';
import reviewRoutes from './review';
import { globalReviewModel } from '../services/reviewModel';

test('GET /api/review logs the caught exception and keeps the generic 500 body', async (t) => {
  const failure = new Error('review scan exploded');
  t.mock.method(globalReviewModel, 'getReviewSummaries', async () => {
    throw failure;
  });
  const logged = t.mock.method(console, 'error', () => {});

  const app = express();
  app.use('/api/review', reviewRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${port}/api/review`);

  // The response contract is unchanged: the cause never reaches the client.
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Failed to build review model' });
  // The cause reaches the server log, stack included (the Error object itself).
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(logged.mock.calls[0].arguments, ['Failed to build review model:', failure]);
});
