import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import type {
  ProjectReadinessResponse,
  ProjectReadinessStatus,
  ReadinessLaneReport,
  RunStatus,
} from '@shared/types';

type SurfaceState = 'connected' | 'partial' | 'gap';
type SyncStatus = 'synced' | 'missing';

interface BackofficeSurfaceEvidence {
  id: string;
  title: string;
  file: string;
  state: SurfaceState;
  apiPaths?: string[];
  gapReason?: string;
}

interface MobileSyncDomainEvidence {
  id: string;
  label: string;
  adminPaths: string[];
  publicPaths: string[];
  status: SyncStatus;
}

export interface RepoReadinessEvidence {
  generatedAt: string;
  backofficeSurfaces: BackofficeSurfaceEvidence[];
  adminContractPaths: string[];
  backofficeUsedAdminPaths: string[];
  mobileSyncDomains: MobileSyncDomainEvidence[];
}

interface FileRecord {
  absolutePath: string;
  relativePath: string;
  content: string;
}

const BACKOFFICE_REPO = 'Games-Labs-backoffice';
const API_REPOS = [
  'api-gateway',
  'shared-lib',
  'Games-Labs-Auth',
  'Games-Labs-Game',
  'Games-Labs-Missions',
  'Games-Labs-Order',
  'Games-Labs-Provider',
  'Games-Labs-User',
  'Games-Labs-Wallet',
];

const API_PATTERN = /\/api\/v1\/[A-Za-z0-9_./:{}?=&-]+/g;
const MOCK_GAP_PATTERN = /\b(mock|localStorage|preview only|not saved|no backend|stays mock|TODO:\s*wire to API|TODO\(api\)|TODO api)\b/i;
const API_WIRING_PATTERN = /\$fetch|useFetch|adminFetch|apiFetch|\/api\/v1\/|useAdmin[A-Za-z0-9_]*Api/i;
const EVIDENCE_SAMPLE_LIMIT = 8;

export class ReadinessService {
  async getProjectReadiness(): Promise<ProjectReadinessResponse> {
    return buildProjectReadinessFromRepoEvidence(await collectRepoReadinessEvidence());
  }
}

export async function collectRepoReadinessEvidence(): Promise<RepoReadinessEvidence> {
  const workspaceRoot = path.dirname(config.aiOfficeRoot);
  const backofficeRoot = path.join(workspaceRoot, BACKOFFICE_REPO);
  const backofficeFiles = await readSourceFiles(path.join(backofficeRoot, 'app'), backofficeRoot, new Set(['.vue', '.ts']));
  const apiRepoFiles = (await Promise.all(API_REPOS.map((repo) => {
    const repoRoot = path.join(workspaceRoot, repo);
    return readSourceFiles(repoRoot, workspaceRoot, new Set(['.go', '.proto', '.ts', '.vue']));
  }))).flat();

  const backofficeSurfaces = buildBackofficeSurfaces(backofficeFiles);
  const backofficeUsedAdminPaths = uniqueSorted(backofficeFiles.flatMap((file) => extractApiPaths(file.content, true)));
  const adminContractPaths = uniqueSorted(apiRepoFiles.flatMap((file) => extractApiPaths(file.content, true)));
  const publicPaths = uniqueSorted(apiRepoFiles.flatMap((file) => extractApiPaths(file.content, false)));
  const mobileSyncDomains = buildMobileSyncDomains(backofficeUsedAdminPaths, publicPaths);

  return {
    generatedAt: new Date().toISOString(),
    backofficeSurfaces,
    adminContractPaths,
    backofficeUsedAdminPaths,
    mobileSyncDomains,
  };
}

export function buildProjectReadinessFromRepoEvidence(evidence: RepoReadinessEvidence): ProjectReadinessResponse {
  const manageSurfaces = adminManageSurfaces(evidence);
  const gamesLanes = [
    buildBackofficeApiLane(evidence),
    buildBackofficeUiLane(evidence),
    buildMobileSyncLane(evidence),
  ];
  const gamesProgress = average(gamesLanes.map((lane) => lane.progress));

  return {
    generatedAt: evidence.generatedAt,
    projects: [
      {
        id: 'games-labs',
        name: 'Games Labs',
        progress: gamesProgress,
        status: statusForProgress(gamesProgress),
        evidence: {
          totalMatchedTasks: manageSurfaces.length + evidence.adminContractPaths.length + evidence.mobileSyncDomains.length,
          scoring: 'Repo evidence: Backoffice UI = connected/partial/gap admin/manage source files; API for Backoffice = admin API paths used by Backoffice admin/manage / admin API contract paths; Mobile/FE API = Backoffice-used admin domains with matching public/mobile API domains.',
        },
        lanes: gamesLanes,
      },
      waitingProject('casper', 'Casper'),
      waitingProject('verify-slip', 'VerifySlip'),
    ],
  };
}

function buildBackofficeUiLane(evidence: RepoReadinessEvidence): ReadinessLaneReport {
  const surfaces = adminManageSurfaces(evidence);
  const total = surfaces.length;
  const connected = surfaces.filter((surface) => surface.state === 'connected').length;
  const partial = surfaces.filter((surface) => surface.state === 'partial').length;
  const gaps = surfaces.filter((surface) => surface.state === 'gap').length;
  const progress = total ? Math.round(((connected + partial * 0.5) / total) * 100) : 0;
  const samples = [
    ...surfaces.filter((surface) => surface.state === 'gap'),
    ...surfaces.filter((surface) => surface.state === 'partial'),
    ...surfaces.filter((surface) => surface.state === 'connected'),
  ].slice(0, EVIDENCE_SAMPLE_LIMIT);

  return {
    id: 'backoffice-ui',
    label: 'Backoffice UI',
    progress,
    status: statusForProgress(progress),
    summary: `${connected} connected, ${partial} partial, ${gaps} not connected from ${total} Backoffice admin/manage surfaces.`,
    readyDefinition: 'Every Backoffice admin/manage surface has real API wiring and no mock/local-only persistence for required data.',
    evidence: {
      totalTasks: total,
      completedTasks: connected,
      reviewTasks: 0,
      activeTasks: partial,
      blockedTasks: gaps,
      failedTasks: 0,
      sampleTasks: samples.map((surface) => evidenceTask(
        surface.id,
        surface.title,
        surfaceStateToStatus(surface.state),
        surface.file,
        [
          ...(surface.apiPaths || []),
          ...(surface.gapReason ? [surface.gapReason] : []),
        ],
      )),
    },
  };
}

function buildBackofficeApiLane(evidence: RepoReadinessEvidence): ReadinessLaneReport {
  const contractSet = new Set(evidence.adminContractPaths);
  const usedSet = new Set(adminManageSurfaces(evidence)
    .flatMap((surface) => surface.apiPaths || []));
  const used = [...usedSet].filter((apiPath) => contractSet.has(apiPath)).length;
  const missing = [...contractSet].filter((apiPath) => !usedSet.has(apiPath));
  const total = contractSet.size;
  const progress = total ? Math.round((used / total) * 100) : 0;
  const samples = [
    ...missing.slice(0, 5).map((apiPath) => evidenceTask(apiPath, 'Admin API contract not used by Backoffice source', 'blocked', apiPath, [apiPath])),
    ...[...usedSet].filter((apiPath) => contractSet.has(apiPath)).slice(0, 3).map((apiPath) => evidenceTask(apiPath, 'Admin API contract used by Backoffice source', 'completed', apiPath, [apiPath])),
  ];

  return {
    id: 'api-backoffice',
    label: 'API for Backoffice',
    progress,
    status: statusForProgress(progress),
    summary: `${used} of ${total} admin API contract paths are used by Backoffice admin/manage source.`,
    readyDefinition: 'Backoffice admin/manage has source-level wiring for the admin API contracts it needs to save/read configured values.',
    evidence: {
      totalTasks: total,
      completedTasks: used,
      reviewTasks: 0,
      activeTasks: 0,
      blockedTasks: missing.length,
      failedTasks: 0,
      sampleTasks: samples,
    },
  };
}

function adminManageSurfaces(evidence: RepoReadinessEvidence): BackofficeSurfaceEvidence[] {
  return evidence.backofficeSurfaces.filter((surface) => surface.id.startsWith('admin/manage/'));
}

function buildMobileSyncLane(evidence: RepoReadinessEvidence): ReadinessLaneReport {
  const total = evidence.mobileSyncDomains.length;
  const synced = evidence.mobileSyncDomains.filter((domain) => domain.status === 'synced').length;
  const missing = total - synced;
  const progress = total ? Math.round((synced / total) * 100) : 0;
  const samples = [
    ...evidence.mobileSyncDomains.filter((domain) => domain.status === 'missing'),
    ...evidence.mobileSyncDomains.filter((domain) => domain.status === 'synced'),
  ].slice(0, EVIDENCE_SAMPLE_LIMIT);

  return {
    id: 'mobile-fe-api',
    label: 'Mobile/FE API',
    progress,
    status: statusForProgress(progress),
    summary: `${synced} synced, ${missing} missing public/mobile API domains for Backoffice-used admin domains.`,
    readyDefinition: 'Each Backoffice-configured domain has a matching public/mobile API domain that can expose the saved values.',
    evidence: {
      totalTasks: total,
      completedTasks: synced,
      reviewTasks: 0,
      activeTasks: 0,
      blockedTasks: missing,
      failedTasks: 0,
      sampleTasks: samples.map((domain) => evidenceTask(
        domain.id,
        domain.label,
        domain.status === 'synced' ? 'completed' : 'blocked',
        domain.publicPaths[0] || domain.adminPaths[0],
        [...domain.adminPaths, ...domain.publicPaths],
      )),
    },
  };
}

function waitingProject(id: string, name: string) {
  const lanes: ReadinessLaneReport[] = [
    'api-backoffice',
    'backoffice-ui',
    'mobile-fe-api',
  ].map((laneId) => ({
    id: laneId as ReadinessLaneReport['id'],
    label: laneId === 'api-backoffice' ? 'API for Backoffice' : laneId === 'backoffice-ui' ? 'Backoffice UI' : 'Mobile/FE API',
    progress: 0,
    status: 'blocked' as ProjectReadinessStatus,
    summary: 'Waiting for project repository evidence.',
    readyDefinition: 'Repository evidence has not been configured for this project yet.',
    evidence: {
      totalTasks: 0,
      completedTasks: 0,
      reviewTasks: 0,
      activeTasks: 0,
      blockedTasks: 0,
      failedTasks: 0,
      sampleTasks: [],
    },
  }));

  return {
    id,
    name,
    progress: 0,
    status: 'blocked' as ProjectReadinessStatus,
    evidence: {
      totalMatchedTasks: 0,
      scoring: 'Waiting for project repository evidence.',
    },
    lanes,
  };
}

function buildBackofficeSurfaces(files: FileRecord[]): BackofficeSurfaceEvidence[] {
  const pageFiles = files.filter((file) => file.relativePath.startsWith('app/pages/admin/') && /\.(vue|ts)$/.test(file.relativePath));
  const byId = new Map<string, BackofficeSurfaceEvidence>();

  for (const file of pageFiles) {
    const id = surfaceIdFromPage(file.relativePath);
    if (!id) continue;
    byId.set(id, surfaceFromFile(id, file));
  }

  const pageData = files.find((file) => file.relativePath === 'app/composables/useAdminPageData.ts');
  if (pageData) {
    for (const mockSurface of mockSurfacesFromPageData(pageData.content)) {
      const id = `admin/${mockSurface.id}`;
      const existing = byId.get(id);
      if (!existing || existing.state === 'gap') {
        byId.set(id, {
          id,
          title: mockSurface.title,
          file: pageData.relativePath,
          state: existing?.state ?? 'gap',
          apiPaths: existing?.apiPaths,
          gapReason: existing?.gapReason ?? 'listed in useAdminPageData mock inventory',
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function surfaceFromFile(id: string, file: FileRecord): BackofficeSurfaceEvidence {
  const apiPaths = extractApiPaths(file.content, true);
  const hasApi = API_WIRING_PATTERN.test(file.content);
  const hasGap = MOCK_GAP_PATTERN.test(file.content);
  const state: SurfaceState = hasApi && hasGap ? 'partial' : hasApi ? 'connected' : 'gap';
  return {
    id,
    title: titleFromSurfaceId(id),
    file: file.relativePath,
    state,
    apiPaths,
    gapReason: hasGap ? 'mock/localStorage/TODO evidence remains in source' : state === 'gap' ? 'no API wiring detected in source' : undefined,
  };
}

function mockSurfacesFromPageData(content: string): Array<{ id: string; title: string }> {
  const surfaces: Array<{ id: string; title: string }> = [];
  const pattern = /^\s*'([^']+)':\s*\{\s*title:\s*'([^']+)'/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    surfaces.push({ id: match[1], title: match[2] });
  }
  return surfaces;
}

function buildMobileSyncDomains(adminPaths: string[], publicPaths: string[]): MobileSyncDomainEvidence[] {
  const publicByDomain = new Map<string, string[]>();
  for (const publicPath of publicPaths) {
    const domain = domainForPath(publicPath);
    if (!domain) continue;
    publicByDomain.set(domain.id, [...(publicByDomain.get(domain.id) || []), publicPath]);
  }

  const adminByDomain = new Map<string, { label: string; paths: string[] }>();
  for (const adminPath of adminPaths) {
    const domain = domainForPath(adminPath);
    if (!domain) continue;
    const existing = adminByDomain.get(domain.id);
    adminByDomain.set(domain.id, {
      label: domain.label,
      paths: [...(existing?.paths || []), adminPath],
    });
  }

  return [...adminByDomain.entries()]
    .map(([id, admin]) => {
      const publicDomainPaths = uniqueSorted(publicByDomain.get(id) || []);
      return {
        id,
        label: admin.label,
        adminPaths: uniqueSorted(admin.paths),
        publicPaths: publicDomainPaths,
        status: publicDomainPaths.length > 0 ? 'synced' as SyncStatus : 'missing' as SyncStatus,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function domainForPath(apiPath: string): { id: string; label: string } | null {
  const lower = apiPath.toLowerCase();
  if (lower.includes('vip-level') || lower.includes('/levels') || lower.includes('/group/level')) return { id: 'vip-levels', label: 'VIP Levels' };
  if (lower.includes('/game') || lower.includes('/category')) return { id: 'games', label: 'Games / Categories' };
  if (lower.includes('order-packages') || lower.includes('/store') || lower.includes('rate-catalog')) return { id: 'store', label: 'Store / Exchange' };
  if (lower.includes('/missions') || lower.includes('/weekly') || lower.includes('/daily') || lower.includes('check-in')) return { id: 'missions', label: 'Missions / Check-in' };
  if (lower.includes('redemption')) return { id: 'redemption', label: 'Redemption' };
  if (lower.includes('/provider')) return { id: 'providers', label: 'Providers' };
  if (lower.includes('/wallet')) return { id: 'wallet', label: 'Wallet' };
  if (lower.includes('/user')) return { id: 'players', label: 'Players' };
  if (lower.includes('/uploads')) return { id: 'uploads', label: 'Uploads' };
  return null;
}

function extractApiPaths(content: string, adminOnly: boolean): string[] {
  const matches = content.match(API_PATTERN) || [];
  return uniqueSorted(matches
    .map(normalizeApiPath)
    .filter((apiPath) => adminOnly ? apiPath.startsWith('/api/v1/admin/') : !apiPath.startsWith('/api/v1/admin/')));
}

function normalizeApiPath(apiPath: string): string {
  return apiPath
    .split(/[?#]/)[0]
    .replace(/[),.;'">`]+$/g, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

async function readSourceFiles(root: string, relativeRoot: string, extensions: Set<string>): Promise<FileRecord[]> {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }

  const output: FileRecord[] = [];
  await walk(root, async (absolutePath) => {
    if (!extensions.has(path.extname(absolutePath))) return;
    const relativePath = path.relative(relativeRoot, absolutePath).split(path.sep).join('/');
    if (shouldSkip(relativePath)) return;
    try {
      output.push({
        absolutePath,
        relativePath,
        content: await fs.readFile(absolutePath, 'utf8'),
      });
    } catch {
      // Ignore transient read failures; the report is best-effort read-only.
    }
  });
  return output;
}

async function walk(dir: string, visit: (absolutePath: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'dist', '.nuxt', '.output', 'vendor', 'coverage'].includes(entry.name)) continue;
      await walk(absolutePath, visit);
    } else if (entry.isFile()) {
      await visit(absolutePath);
    }
  }
}

function shouldSkip(relativePath: string): boolean {
  return relativePath.includes('/node_modules/')
    || relativePath.includes('/dist/')
    || relativePath.includes('/.nuxt/')
    || relativePath.includes('/.output/')
    || relativePath.includes('/coverage/')
    || relativePath.endsWith('_test.go')
    || relativePath.endsWith('.test.ts');
}

function surfaceIdFromPage(relativePath: string): string | null {
  const prefix = 'app/pages/admin/';
  if (!relativePath.startsWith(prefix)) return null;
  if (relativePath.includes('[...')) return null;
  return `admin/${relativePath.slice(prefix.length)
    .replace(/\.vue$|\.ts$/g, '')
    .replace(/\/index$/g, '')
    .replace(/\/\[id\]/g, '/:id')
    .replace(/\/Detail\//g, '/detail/')}`;
}

function titleFromSurfaceId(id: string): string {
  return id.split('/').filter(Boolean).slice(-2).join(' / ') || id;
}

function evidenceTask(id: string, title: string, status: RunStatus, source: string | undefined, matchedKeywords: string[]) {
  return {
    id,
    title,
    status,
    source,
    matchedKeywords: uniqueSorted(matchedKeywords),
  };
}

function surfaceStateToStatus(state: SurfaceState): RunStatus {
  if (state === 'connected') return 'completed';
  if (state === 'partial') return 'running';
  return 'blocked';
}

function statusForProgress(progress: number): ProjectReadinessStatus {
  if (progress >= 75) return 'on-track';
  if (progress >= 40) return 'attention';
  return 'blocked';
}

function average(values: number[]): number {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
