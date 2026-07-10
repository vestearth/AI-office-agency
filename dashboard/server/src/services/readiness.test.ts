import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectReadinessFromRepoEvidence, hasMockGapEvidence, normalizeApiPath } from './readiness';
import type { RepoReadinessEvidence } from './readiness';

test('hasMockGapEvidence flags real local-only persistence, not type imports or comments', () => {
  // Real gaps: local-only persistence, preview-only pages, wire-to-API TODOs, mock-value imports.
  assert.equal(hasMockGapEvidence("const x = localStorage.getItem('draft')"), true);
  assert.equal(hasMockGapEvidence('This will update the preview only. It will not be saved to the server.'), true);
  assert.equal(hasMockGapEvidence('// TODO: wire to API'), true);
  assert.equal(hasMockGapEvidence("import { weeklyMissions } from '~/data/mock'"), true);

  // Not gaps: type-only imports from a module named mock, and the word in comments.
  assert.equal(hasMockGapEvidence("import type { WeeklyDefaultMission } from '~/data/mock'"), false);
  assert.equal(hasMockGapEvidence('/* map the trio the mock/UI used at the call site */'), false);
  assert.equal(hasMockGapEvidence("const rows = await $fetch('/api/v1/admin/missions')"), false);
});

test('normalizeApiPath collapses path params so frontend usage matches the backend contract', () => {
  // Backend contract param spellings and frontend spellings must all canonicalize equal.
  const canonical = '/api/v1/admin/activities/{}';
  assert.equal(normalizeApiPath('/api/v1/admin/activities/{activityId}'), canonical);
  assert.equal(normalizeApiPath('/api/v1/admin/activities/{activity_id}'), canonical);
  assert.equal(normalizeApiPath('/api/v1/admin/activities/:id'), canonical);
  assert.equal(normalizeApiPath('/api/v1/admin/activities/{id}'), canonical);
  assert.equal(normalizeApiPath('/api/v1/admin/activities/${activityId}'), canonical);
  // Truncated template interpolation (API_PATTERN stops at the first uncaptured char).
  assert.equal(normalizeApiPath('/api/v1/admin/activities/${encodeURIComponent'), canonical);
});

test('normalizeApiPath keeps concrete segments and query/proto noise from merging paths', () => {
  // A named resource segment is not a param and must stay distinct from `{}`.
  assert.equal(
    normalizeApiPath('/api/v1/admin/activities/daily-turnover-500'),
    '/api/v1/admin/activities/daily-turnover-500',
  );
  assert.notEqual(
    normalizeApiPath('/api/v1/admin/activities/daily-turnover-500'),
    normalizeApiPath('/api/v1/admin/activities/{activity_id}'),
  );
  // Query strings drop; a mid-path param still collapses.
  assert.equal(normalizeApiPath('/api/v1/admin/activity-groups/{group_id}/members?id=x'), '/api/v1/admin/activity-groups/{}/members');
});

test('buildProjectReadinessFromRepoEvidence scores Games Labs from repo wiring evidence', () => {
  const evidence: RepoReadinessEvidence = {
    generatedAt: '2026-07-08T00:00:00.000Z',
    backofficeSurfaces: [
      { id: 'admin/manage/vip', title: 'VIP', file: 'app/pages/admin/manage/vip/index.vue', state: 'connected', apiPaths: ['/api/v1/admin/levels'] },
      { id: 'admin/settings/banner', title: 'Banner', file: 'app/pages/admin/settings/banner.vue', state: 'connected', apiPaths: ['/api/v1/admin/banner'] },
      { id: 'admin/manage/missions/weekly/settings', title: 'Weekly Settings', file: 'app/pages/admin/manage/missions/weekly/settings.vue', state: 'partial', apiPaths: ['/api/v1/admin/missions/config'], gapReason: 'mock fallback remains' },
    ],
    adminContractPaths: [
      '/api/v1/admin/levels',
      '/api/v1/admin/levels/{id}',
      '/api/v1/admin/missions/config',
      '/api/v1/admin/banner',
    ],
    backofficeUsedAdminPaths: [
      '/api/v1/admin/levels',
      '/api/v1/admin/missions/config',
    ],
    mobileSyncDomains: [
      {
        id: 'vip-levels',
        label: 'VIP Levels',
        adminPaths: ['/api/v1/admin/levels'],
        publicPaths: ['/api/v1/vip-levels/{level}'],
        status: 'synced',
      },
      {
        id: 'missions-config',
        label: 'Mission Config',
        adminPaths: ['/api/v1/admin/missions/config'],
        publicPaths: [],
        status: 'missing',
      },
    ],
  };

  const report = buildProjectReadinessFromRepoEvidence(evidence);
  const gamesLabs = report.projects[0];

  assert.equal(gamesLabs.name, 'Games Labs');
  assert.equal(gamesLabs.lanes.find((lane) => lane.id === 'backoffice-ui')?.progress, 75);
  assert.equal(gamesLabs.lanes.find((lane) => lane.id === 'api-backoffice')?.progress, 67);
  assert.equal(gamesLabs.lanes.find((lane) => lane.id === 'mobile-fe-api')?.progress, 50);
  assert.equal(gamesLabs.progress, 64);

  assert.deepEqual(report.projects.slice(1).map((project) => project.name), ['Casper', 'VerifySlip']);
  assert.equal(report.projects[1].progress, 0);
  assert.equal(report.projects[1].lanes[0].summary, '0 connected, 0 partial, 0 gaps from 0 required capabilities.');
});

test('buildProjectReadinessFromRepoEvidence scores Casper from API, storefront, and commerce evidence', () => {
  const connected = (id: string) => ({ id, title: id, source: `${id}.ts`, state: 'connected' as const, matchedKeywords: [id] });
  const partial = (id: string) => ({ id, title: id, source: `${id}.ts`, state: 'partial' as const, matchedKeywords: [id] });
  const gap = (id: string) => ({ id, title: id, source: `${id}.ts`, state: 'gap' as const, matchedKeywords: [id] });
  const evidence: RepoReadinessEvidence = {
    generatedAt: '2026-07-10T00:00:00.000Z',
    backofficeSurfaces: [],
    adminContractPaths: [],
    backofficeUsedAdminPaths: [],
    mobileSyncDomains: [],
    casperApiCapabilities: [connected('auth'), connected('catalog'), connected('orders')],
    casperUiCapabilities: [connected('auth-ui'), connected('catalog-ui'), partial('checkout-ui'), gap('orders-ui')],
    casperCommerceCapabilities: [connected('auth-flow'), connected('catalog-flow'), partial('order-flow'), partial('payment-flow'), partial('history-flow')],
  };

  const casper = buildProjectReadinessFromRepoEvidence(evidence).projects[1];

  assert.equal(casper.name, 'Casper');
  assert.equal(casper.lanes.find((lane) => lane.id === 'api-backoffice')?.label, 'API for Client');
  assert.equal(casper.lanes.find((lane) => lane.id === 'api-backoffice')?.progress, 100);
  assert.equal(casper.lanes.find((lane) => lane.id === 'backoffice-ui')?.progress, 63);
  assert.equal(casper.lanes.find((lane) => lane.id === 'mobile-fe-api')?.progress, 70);
  assert.equal(casper.progress, 78);
  assert.equal(casper.status, 'on-track');
  assert.equal(casper.evidence.totalMatchedTasks, 12);
});

test('Backoffice UI counts only admin/manage surfaces for this reporting round', () => {
  const evidence: RepoReadinessEvidence = {
    generatedAt: '2026-07-08T00:00:00.000Z',
    backofficeSurfaces: [
      { id: 'admin/manage/vip', title: 'VIP', file: 'app/pages/admin/manage/vip/index.vue', state: 'connected', apiPaths: ['/api/v1/admin/levels'] },
      { id: 'admin/manage/missions/weekly/settings', title: 'Weekly Settings', file: 'app/pages/admin/manage/missions/weekly/settings.vue', state: 'partial', apiPaths: ['/api/v1/admin/missions/config'], gapReason: 'mock fallback remains' },
      { id: 'admin/settings/banner', title: 'Banner', file: 'app/pages/admin/settings/banner.vue', state: 'connected', apiPaths: ['/api/v1/admin/banner'] },
      { id: 'admin/financial', title: 'Financial Overview', file: 'app/composables/useAdminPageData.ts', state: 'gap', gapReason: 'mock inventory' },
    ],
    adminContractPaths: [],
    backofficeUsedAdminPaths: [],
    mobileSyncDomains: [],
  };

  const uiLane = buildProjectReadinessFromRepoEvidence(evidence)
    .projects[0]
    .lanes.find((lane) => lane.id === 'backoffice-ui');

  assert.equal(uiLane?.progress, 75);
  assert.equal(uiLane?.summary, '1 connected, 1 partial, 0 not connected from 2 Backoffice admin/manage surfaces.');
  assert.deepEqual(uiLane?.evidence.sampleTasks.map((task) => task.id), [
    'admin/manage/missions/weekly/settings',
    'admin/manage/vip',
  ]);
  assert.equal(uiLane?.evidence.sampleTasks[0].source, 'app/pages/admin/manage/missions/weekly/settings.vue');
});

test('API for Backoffice counts contracts wired via composables, not only page-level paths', () => {
  // A manage page that delegates fetching to a composable has no admin path
  // literal of its own (surface.apiPaths empty), but the composable-defined
  // path shows up in backofficeUsedAdminPaths. That must still count as used.
  const evidence: RepoReadinessEvidence = {
    generatedAt: '2026-07-08T00:00:00.000Z',
    backofficeSurfaces: [
      { id: 'admin/manage/store/exchange', title: 'Store Exchange', file: 'app/pages/admin/manage/store/exchange.vue', state: 'connected', apiPaths: [] },
    ],
    adminContractPaths: [
      '/api/v1/admin/order-packages',
      '/api/v1/admin/order-packages/{}',
    ],
    backofficeUsedAdminPaths: [
      '/api/v1/admin/order-packages',
    ],
    mobileSyncDomains: [],
  };

  const apiLane = buildProjectReadinessFromRepoEvidence(evidence)
      .projects[0]
      .lanes.find((lane) => lane.id === 'api-backoffice');

  // Domain (store) is inferred from the surface route even with no page paths;
  // 1 of the 2 store contracts is wired through the composable.
  assert.equal(apiLane?.progress, 50);
  assert.equal(apiLane?.summary, '1 of 2 admin/manage domain admin API contract paths are used by Backoffice admin/manage source.');
});

test('API for Backoffice counts only admin/manage domain contracts for this reporting round', () => {
  const evidence: RepoReadinessEvidence = {
    generatedAt: '2026-07-08T00:00:00.000Z',
    backofficeSurfaces: [
      { id: 'admin/manage/vip', title: 'VIP', file: 'app/pages/admin/manage/vip/index.vue', state: 'connected', apiPaths: ['/api/v1/admin/levels'] },
      { id: 'admin/settings/banner', title: 'Banner', file: 'app/pages/admin/settings/banner.vue', state: 'connected', apiPaths: ['/api/v1/admin/banner'] },
    ],
    adminContractPaths: [
      '/api/v1/admin/levels',
      '/api/v1/admin/levels/{level}',
      '/api/v1/admin/banner',
      '/api/v1/admin/activities',
    ],
    backofficeUsedAdminPaths: [
      '/api/v1/admin/levels',
      '/api/v1/admin/banner',
    ],
    mobileSyncDomains: [],
  };

  const apiLane = buildProjectReadinessFromRepoEvidence(evidence)
      .projects[0]
      .lanes.find((lane) => lane.id === 'api-backoffice');

  assert.equal(apiLane?.progress, 50);
  assert.equal(apiLane?.summary, '1 of 2 admin/manage domain admin API contract paths are used by Backoffice admin/manage source.');
  assert.deepEqual(apiLane?.evidence.sampleTasks.map((task) => task.id), [
    '/api/v1/admin/levels/{level}',
    '/api/v1/admin/levels',
  ]);
  assert.equal(apiLane?.evidence.sampleTasks[0].source, '/api/v1/admin/levels/{level}');
});
