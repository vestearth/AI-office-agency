import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectReadinessFromRepoEvidence } from './readiness';
import type { RepoReadinessEvidence } from './readiness';

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
  assert.equal(report.projects[1].lanes[0].summary, 'Waiting for project repository evidence.');
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

test('API for Backoffice counts only admin/manage source wiring for this reporting round', () => {
  const evidence: RepoReadinessEvidence = {
    generatedAt: '2026-07-08T00:00:00.000Z',
    backofficeSurfaces: [
      { id: 'admin/manage/vip', title: 'VIP', file: 'app/pages/admin/manage/vip/index.vue', state: 'connected', apiPaths: ['/api/v1/admin/levels'] },
      { id: 'admin/settings/banner', title: 'Banner', file: 'app/pages/admin/settings/banner.vue', state: 'connected', apiPaths: ['/api/v1/admin/banner'] },
    ],
    adminContractPaths: [
      '/api/v1/admin/levels',
      '/api/v1/admin/banner',
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
  assert.equal(apiLane?.summary, '1 of 2 admin API contract paths are used by Backoffice admin/manage source.');
  assert.deepEqual(apiLane?.evidence.sampleTasks.map((task) => task.id), [
    '/api/v1/admin/banner',
    '/api/v1/admin/levels',
  ]);
  assert.equal(apiLane?.evidence.sampleTasks[0].source, '/api/v1/admin/banner');
});
