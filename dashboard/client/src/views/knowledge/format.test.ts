import { describe, test, expect } from 'vitest';
import {
  formatReviewDate,
  groupPathsByRoot,
  humanizeLabel,
  maxPriority,
  normalizeLabel,
  reviewRepos,
  reviewTitle,
  shouldShowProduct,
  sortFindingsByPriority,
  OTHER_PATH_GROUP,
} from './format';
import type { KnowledgeReviewFinding } from '@shared/types';

describe('humanizeLabel', () => {
  test('title-cases separated words', () => {
    expect(humanizeLabel('games-labs-store_items')).toBe('Games Labs Store Items');
  });

  test('keeps known acronyms upper-case', () => {
    expect(humanizeLabel('games-labs-vip-profile-display-contract')).toBe('Games Labs VIP Profile Display Contract');
    expect(humanizeLabel('adr-and-api-and-ui')).toBe('ADR And API And UI');
  });

  test('survives empty input', () => {
    expect(humanizeLabel('')).toBe('');
  });
});

describe('reviewTitle', () => {
  test('strips the KLR timestamp prefix', () => {
    expect(reviewTitle('KLR-20260722T082402Z-games-labs-store-avatar-list-vip-boundary', 'games_labs'))
      .toBe('Games Labs Store Avatar List VIP Boundary');
  });

  test('falls back to the product when the slug is empty', () => {
    expect(reviewTitle('KLR-20260722T082402Z-', 'games_labs')).toBe('Games Labs');
  });
});

describe('shouldShowProduct', () => {
  test('hides a product identical to the title', () => {
    const title = reviewTitle('KLR-20260724T102918Z-games-labs-backoffice-pass-game-support', 'games_labs_backoffice_pass_game_support');
    expect(shouldShowProduct('games_labs_backoffice_pass_game_support', title)).toBe(false);
  });

  test('hides a product the title already contains', () => {
    const title = reviewTitle('KLR-20260722T082402Z-games-labs-store-avatar-list-vip-boundary', 'games_labs');
    expect(shouldShowProduct('games_labs', title)).toBe(false);
  });

  test('shows a product that carries independent information', () => {
    const title = reviewTitle('KLR-20260724T180805Z-ai-office-dashboard-knowledge-tab', 'ai_office_agency');
    expect(shouldShowProduct('ai_office_agency', title)).toBe(true);
  });

  test('hides an empty product', () => {
    expect(shouldShowProduct('', 'Anything')).toBe(false);
  });
});

describe('normalizeLabel', () => {
  test('reduces to lower-case alphanumerics', () => {
    expect(normalizeLabel('Games Labs weekly review 2026W30')).toBe('gameslabsweeklyreview2026w30');
  });
});

describe('groupPathsByRoot', () => {
  test('groups by first segment and strips the shared prefix', () => {
    const groups = groupPathsByRoot([
      'Games-Labs-Missions/proto/missionspb/missions.proto',
      'Knowledge Base/10 Projects/Games Labs Missions/Project Map.md',
      'Games-Labs-Missions/internal/models/models.go',
    ]);
    expect(groups).toEqual([
      { root: 'Games-Labs-Missions', paths: ['proto/missionspb/missions.proto', 'internal/models/models.go'] },
      { root: 'Knowledge Base', paths: ['10 Projects/Games Labs Missions/Project Map.md'] },
    ]);
  });

  test('sinks non-path entries into a trailing catch-all, verbatim', () => {
    const groups = groupPathsByRoot([
      'Games-Labs-Wallet draft PR #9',
      'https://sparqlab.example/thing',
      'shared-lib/pkg/localized/localized.go',
      'AGENTS.md',
    ]);
    expect(groups[0]).toEqual({ root: 'shared-lib', paths: ['pkg/localized/localized.go'] });
    expect(groups[groups.length - 1]).toEqual({
      root: OTHER_PATH_GROUP,
      paths: ['Games-Labs-Wallet draft PR #9', 'https://sparqlab.example/thing', 'AGENTS.md'],
    });
  });

  test('treats a leading slash as unrooted rather than an empty group', () => {
    const groups = groupPathsByRoot(['/absolute/path.md']);
    expect(groups).toEqual([{ root: OTHER_PATH_GROUP, paths: ['/absolute/path.md'] }]);
  });

  test('returns nothing for no paths', () => {
    expect(groupPathsByRoot([])).toEqual([]);
  });
});

describe('reviewRepos', () => {
  test('lists real roots only, largest group first', () => {
    expect(reviewRepos([
      'Knowledge Base/Review Queue.md',
      'Games-Labs-Order/services/ordersvc/service.go',
      'Games-Labs-Order/admin/adminorderpb/adminorder.proto',
      'some free text',
    ])).toEqual(['Games-Labs-Order', 'Knowledge Base']);
  });
});

describe('maxPriority', () => {
  test('picks the most severe present', () => {
    expect(maxPriority({ high: 2, low: 1 })).toBe('high');
    expect(maxPriority({ critical: 1, high: 2, low: 1 })).toBe('critical');
    expect(maxPriority({ low: 3 })).toBe('low');
  });

  test('returns null for no findings or a missing field', () => {
    expect(maxPriority({})).toBe(null);
    expect(maxPriority(undefined)).toBe(null);
  });
});

describe('sortFindingsByPriority', () => {
  const finding = (fingerprint: string, priority: KnowledgeReviewFinding['priority']) =>
    ({ fingerprint, priority } as KnowledgeReviewFinding);

  test('orders critical first and low last, stable within a tier', () => {
    const sorted = sortFindingsByPriority([
      finding('a', 'low'),
      finding('b', 'high'),
      finding('c', 'critical'),
      finding('d', 'high'),
      finding('e', 'medium'),
    ]);
    expect(sorted.map((item) => item.fingerprint)).toEqual(['c', 'b', 'd', 'e', 'a']);
  });

  test('does not mutate the input', () => {
    const input = [finding('a', 'low'), finding('b', 'critical')];
    sortFindingsByPriority(input);
    expect(input.map((item) => item.fingerprint)).toEqual(['a', 'b']);
  });
});

describe('formatReviewDate', () => {
  const now = new Date('2026-07-25T12:00:00Z');

  test('uses relative time under 48 hours', () => {
    expect(formatReviewDate('2026-07-25T11:59:40Z', now)).toBe('just now');
    expect(formatReviewDate('2026-07-25T11:30:00Z', now)).toBe('30m ago');
    expect(formatReviewDate('2026-07-24T12:00:00Z', now)).toBe('24h ago');
  });

  test('uses a short date beyond 48 hours', () => {
    expect(formatReviewDate('2026-07-22T08:24:02Z', now)).toBe('22 Jul');
  });

  test('includes the year when it differs from now', () => {
    expect(formatReviewDate('2025-12-01T08:00:00Z', now)).toBe('1 Dec 2025');
  });

  test('returns the input unchanged when it is not a date', () => {
    expect(formatReviewDate('not-a-date', now)).toBe('not-a-date');
  });
});
