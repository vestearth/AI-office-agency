import assert from 'node:assert/strict';
import { test } from 'vitest';
import { evidenceDetails } from '../src/views/ReportsView';

test('an API-contract row shows its path once: no Source or keyword line that repeats the id', () => {
  const path = '/api/v1/admin/category-games/reorder';
  assert.deepEqual(
    evidenceDetails({ id: path, title: 'Admin API contract not used by Backoffice source', status: 'blocked', source: path, matchedKeywords: [path] }),
    { source: null, keywords: [] },
  );
});

test('a UI-surface row keeps a source file and keywords that add information', () => {
  assert.deepEqual(
    evidenceDetails({
      id: 'admin/manage/leaderboard', title: 'manage / leaderboard', status: 'blocked',
      source: 'app/pages/admin/manage/leaderboard/index.vue', matchedKeywords: ['no API wiring detected in source', 'app/pages/admin/manage/leaderboard/index.vue'],
    }),
    { source: 'app/pages/admin/manage/leaderboard/index.vue', keywords: ['no API wiring detected in source'] },
  );
});
