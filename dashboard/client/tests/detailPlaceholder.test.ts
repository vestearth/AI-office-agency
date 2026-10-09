import assert from 'node:assert/strict';
import { test } from 'vitest';
import { detailPlaceholder } from '../src/views/detailPlaceholder.ts';

test('a failed detail fetch says so instead of claiming the file is absent', () => {
  assert.equal(
    detailPlaceholder({ loading: false, error: 'Failed to fetch' }, 'No task.md found.'),
    'Could not load task detail (Failed to fetch).',
  );
});

test('loading and a genuinely empty detail keep their own text', () => {
  assert.equal(detailPlaceholder({ loading: true, error: null }, 'No task.md found.'), 'Loading…');
  assert.equal(detailPlaceholder({ loading: false, error: null }, 'No task.md found.'), 'No task.md found.');
});
