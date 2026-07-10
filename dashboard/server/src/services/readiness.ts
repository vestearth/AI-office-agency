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

interface CasperCapabilityEvidence {
  id: string;
  title: string;
  source: string;
  state: SurfaceState;
  matchedKeywords: string[];
}

export interface RepoReadinessEvidence {
  generatedAt: string;
  backofficeSurfaces: BackofficeSurfaceEvidence[];
  adminContractPaths: string[];
  backofficeUsedAdminPaths: string[];
  mobileSyncDomains: MobileSyncDomainEvidence[];
  casperApiCapabilities?: CasperCapabilityEvidence[];
  casperUiCapabilities?: CasperCapabilityEvidence[];
  casperCommerceCapabilities?: CasperCapabilityEvidence[];
}

interface FileRecord {
  absolutePath: string;
  relativePath: string;
  content: string;
}

const BACKOFFICE_REPO = 'Games-Labs-backoffice';
const CASPER_CLIENT_REPO = 'casperacc';
const CASPER_API_REPO = 'casperacc-api';
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

const API_PATTERN = /\/api\/v1\/[A-Za-z0-9_./:{}$?=&-]+/g;
// Only runtime evidence that data is NOT really persisted counts as a gap.
// The bare word `mock` is excluded on purpose: admin API composables import
// their row/schedule *types* from a `~/data/mock` module (`import type … from
// '…/mock'`) and mention "mock" in comments while fetching from the real API —
// counting those flagged every wired page as partial.
const MOCK_GAP_PATTERN = new RegExp([
  'localStorage\\.(?:get|set|remove)Item',                    // local-only persistence
  "import\\s+(?!type\\b)[^;\\n]*from\\s+['\"][^'\"]*\\/mock['\"]", // runtime import of mock values (not `import type`)
  'preview only',
  'not saved to the server',
  'no backend',
  'stays mock',
  'TODO:?\\s*wire to API',
  'TODO\\(api\\)',
  'TODO api',
].join('|'), 'i');
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
  const casperClientRoot = path.join(workspaceRoot, CASPER_CLIENT_REPO);
  const casperApiRoot = path.join(workspaceRoot, CASPER_API_REPO);
  const [casperClientFiles, casperApiFiles] = await Promise.all([
    readSourceFiles(casperClientRoot, casperClientRoot, new Set(['.vue', '.ts'])),
    readSourceFiles(casperApiRoot, casperApiRoot, new Set(['.go'])),
  ]);

  const backofficeSurfaces = buildBackofficeSurfaces(backofficeFiles);
  const backofficeUsedAdminPaths = uniqueSorted(backofficeFiles.flatMap((file) => extractApiPaths(file.content, true)));
  const adminContractPaths = uniqueSorted(apiRepoFiles.flatMap((file) => extractApiPaths(file.content, true)));
  const publicPaths = uniqueSorted(apiRepoFiles.flatMap((file) => extractApiPaths(file.content, false)));
  // Manage pages mostly delegate admin calls to composables, so per-page
  // apiPaths are empty for whole domains (vip-levels, missions, providers).
  // Derive the manage admin domains from every admin path used anywhere in
  // Backoffice source, scoped to the domains the manage menu owns — otherwise
  // the mobile lane silently evaluates only the handful of domains that happen
  // to inline a path and reports a misleading 100%.
  const manageDomainIds = new Set(filterAdminManageSurfaces(backofficeSurfaces).flatMap(surfaceDomainIds));
  const manageDomainAdminPaths = backofficeUsedAdminPaths.filter((apiPath) => {
    const domain = domainForPath(apiPath);
    return domain ? manageDomainIds.has(domain.id) : false;
  });
  const mobileSyncDomains = buildMobileSyncDomains(manageDomainAdminPaths, publicPaths);
  const casperEvidence = buildCasperEvidence(casperClientFiles, casperApiFiles);

  return {
    generatedAt: new Date().toISOString(),
    backofficeSurfaces,
    adminContractPaths,
    backofficeUsedAdminPaths,
    mobileSyncDomains,
    ...casperEvidence,
  };
}

export function buildProjectReadinessFromRepoEvidence(evidence: RepoReadinessEvidence): ProjectReadinessResponse {
  const manageSurfaces = adminManageSurfaces(evidence);
  const requiredBackofficeAdminPaths = requiredAdminContractPaths(evidence);
  const gamesLanes = [
    buildBackofficeApiLane(evidence),
    buildBackofficeUiLane(evidence),
    buildMobileSyncLane(evidence),
  ];
  const gamesProgress = average(gamesLanes.map((lane) => lane.progress));
  const casper = buildCasperProject(evidence);

  return {
    generatedAt: evidence.generatedAt,
    projects: [
      {
        id: 'games-labs',
        name: 'Games Labs',
        progress: gamesProgress,
        status: statusForProgress(gamesProgress),
        evidence: {
          totalMatchedTasks: manageSurfaces.length + requiredBackofficeAdminPaths.length + evidence.mobileSyncDomains.length,
          scoring: 'Repo evidence: Backoffice UI = connected/partial/gap admin/manage source files; API for Backoffice = admin/manage-domain admin API paths used by Backoffice admin/manage / required admin/manage-domain admin API contract paths; Mobile/FE API = Backoffice admin/manage-used admin domains with matching public/mobile API domains.',
        },
        lanes: gamesLanes,
      },
      casper,
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
  const contractSet = new Set(requiredAdminContractPaths(evidence));
  // Backoffice pages mostly delegate wiring to shared composables (useAdmin*Api,
  // `${gatewayBase}/api/v1/admin/...`), so the page file itself often has no
  // admin path literal. Match against every admin path used anywhere in the
  // Backoffice source, not just the manage page files; domain scope is already
  // enforced by the manage-domain contract denominator above.
  const usedSet = new Set(evidence.backofficeUsedAdminPaths);
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
    summary: `${used} of ${total} admin/manage domain admin API contract paths are used by Backoffice admin/manage source.`,
    readyDefinition: 'Backoffice admin/manage has source-level wiring for the admin API contracts in its current menu domains.',
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
  return filterAdminManageSurfaces(evidence.backofficeSurfaces);
}

function filterAdminManageSurfaces(surfaces: BackofficeSurfaceEvidence[]): BackofficeSurfaceEvidence[] {
  return surfaces.filter((surface) => surface.id.startsWith('admin/manage/'));
}

function requiredAdminContractPaths(evidence: RepoReadinessEvidence): string[] {
  const requiredDomainIds = new Set(adminManageSurfaces(evidence).flatMap(surfaceDomainIds));
  return evidence.adminContractPaths.filter((apiPath) => {
    const domain = domainForPath(apiPath);
    return domain ? requiredDomainIds.has(domain.id) : false;
  });
}

function surfaceDomainIds(surface: BackofficeSurfaceEvidence): string[] {
  return uniqueSorted([
    ...((surface.apiPaths || []).map((apiPath) => domainForPath(apiPath)?.id).filter(Boolean) as string[]),
    domainForPath(`/api/v1/${surface.id}`)?.id,
  ].filter(Boolean) as string[]);
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
    summary: `${synced} synced, ${missing} missing public/mobile API domains for Backoffice admin/manage-used admin domains.`,
    readyDefinition: 'Each Backoffice admin/manage-configured domain has a matching public/mobile API domain that can expose the saved values.',
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

function buildCasperProject(evidence: RepoReadinessEvidence) {
  const lanes = [
    buildCasperLane('api-backoffice', 'API for Client', evidence.casperApiCapabilities || [], 'Required customer API capabilities exist in casperacc-api and are protected where appropriate.'),
    buildCasperLane('backoffice-ui', 'Storefront UI', evidence.casperUiCapabilities || [], 'Core customer surfaces use real API data; mock and Coming Soon behavior is counted as partial or blocked.'),
    buildCasperLane('mobile-fe-api', 'Commerce E2E', evidence.casperCommerceCapabilities || [], 'A customer can authenticate, browse, create and pay for an order, then inspect its resulting status from the client.'),
  ];
  const progress = average(lanes.map((lane) => lane.progress));
  const totalMatchedTasks = lanes.reduce((sum, lane) => sum + lane.evidence.totalTasks, 0);

  return {
    id: 'casper',
    name: 'Casper',
    progress,
    status: statusForProgress(progress),
    evidence: {
      totalMatchedTasks,
      scoring: 'Repo evidence: API for Client = required casperacc-api route capabilities; Storefront UI = real/partial/gap customer surfaces in casperacc; Commerce E2E = client-to-API authentication, catalog, order, payment, and order-history flows.',
    },
    lanes,
  };
}

function buildCasperLane(
  id: ReadinessLaneReport['id'],
  label: string,
  capabilities: CasperCapabilityEvidence[],
  readyDefinition: string,
): ReadinessLaneReport {
  const completed = capabilities.filter((capability) => capability.state === 'connected').length;
  const partial = capabilities.filter((capability) => capability.state === 'partial').length;
  const blocked = capabilities.filter((capability) => capability.state === 'gap').length;
  const progress = capabilities.length
    ? Math.round(((completed + partial * 0.5) / capabilities.length) * 100)
    : 0;

  return {
    id,
    label,
    progress,
    status: statusForProgress(progress),
    summary: `${completed} connected, ${partial} partial, ${blocked} gaps from ${capabilities.length} required capabilities.`,
    readyDefinition,
    evidence: {
      totalTasks: capabilities.length,
      completedTasks: completed,
      reviewTasks: 0,
      activeTasks: partial,
      blockedTasks: blocked,
      failedTasks: 0,
      sampleTasks: [
        ...capabilities.filter((capability) => capability.state === 'gap'),
        ...capabilities.filter((capability) => capability.state === 'partial'),
        ...capabilities.filter((capability) => capability.state === 'connected'),
      ].slice(0, EVIDENCE_SAMPLE_LIMIT).map((capability) => evidenceTask(
        capability.id,
        capability.title,
        surfaceStateToStatus(capability.state),
        capability.source,
        capability.matchedKeywords,
      )),
    },
  };
}

function buildCasperEvidence(clientFiles: FileRecord[], apiFiles: FileRecord[]) {
  const client = fileContentsByPath(clientFiles);
  const api = fileContentsByPath(apiFiles);
  const routeSource = api.get('internal/handler/router/router.go') || '';
  const apiCapability = (id: string, title: string, paths: string[]): CasperCapabilityEvidence => ({
    id,
    title,
    source: 'casperacc-api/internal/handler/router/router.go',
    state: paths.every((apiPath) => routeSource.includes(apiPath)) ? 'connected' : 'gap',
    matchedKeywords: paths,
  });
  const clientCapability = (
    id: string,
    title: string,
    source: string,
    connectedPatterns: string[],
    gapPatterns: string[] = [],
  ): CasperCapabilityEvidence => {
    const content = client.get(source) || '';
    const connected = connectedPatterns.length > 0
      && connectedPatterns.every((pattern) => content.includes(pattern));
    const hasGap = gapPatterns.some((pattern) => content.includes(pattern));
    return {
      id,
      title,
      source: `casperacc/${source}`,
      state: connected && hasGap ? 'partial' : connected ? 'connected' : hasGap ? 'gap' : 'gap',
      matchedKeywords: [...connectedPatterns, ...gapPatterns],
    };
  };

  const casperApiCapabilities = [
    apiCapability('auth', 'Register and login', ['/auth/register', '/auth/login']),
    apiCapability('profile', 'Authenticated profile', ['/users/me']),
    apiCapability('catalog', 'Catalog list and detail', ['/products', '/products/{id}']),
    apiCapability('orders', 'Order create, list and status', ['/orders', '/orders/{out_trade_no}']),
    apiCapability('payments', 'Payment status and callbacks', ['/payments/{id}', '/callbacks/stripe', '/callbacks/ubit-deposit']),
    apiCapability('cart', 'Shopping cart', ['/cart', '/cart/items']),
    apiCapability('favorites', 'Favorites', ['/favorites']),
  ];

  const casperUiCapabilities = [
    clientCapability('auth-ui', 'Authentication UI', 'app/features/auth/services/authService.ts', ['/auth/login', '/auth/register', '/users/me']),
    clientCapability('catalog-ui', 'Catalog UI', 'app/features/product/services/productService.ts', ['/products', '/products/${productId}']),
    clientCapability('checkout-ui', 'Checkout UI', 'app/features/checkout/ui/CheckoutModal.vue', ['function onPay'], ['mock ถือว่าจ่ายสำเร็จ', 'walletStore.deduct']),
    clientCapability('orders-ui', 'Order history', 'app/pages/orders.vue', [], ['ComingSoon']),
    clientCapability('wishlist-ui', 'Wishlist persistence', 'app/stores/wishlist.ts', ['defineStore'], ['mock ยังไม่มี backend']),
    clientCapability('profile-ui', 'Profile management', 'app/pages/profile.vue', [], ['ComingSoon']),
  ];

  const authUi = casperUiCapabilities.find((capability) => capability.id === 'auth-ui')!;
  const catalogUi = casperUiCapabilities.find((capability) => capability.id === 'catalog-ui')!;
  const checkoutUi = casperUiCapabilities.find((capability) => capability.id === 'checkout-ui')!;
  const ordersUi = casperUiCapabilities.find((capability) => capability.id === 'orders-ui')!;
  const ordersApi = casperApiCapabilities.find((capability) => capability.id === 'orders')!;
  const paymentsApi = casperApiCapabilities.find((capability) => capability.id === 'payments')!;
  const flow = (id: string, title: string, apiCapabilityEvidence: CasperCapabilityEvidence, uiCapabilityEvidence: CasperCapabilityEvidence): CasperCapabilityEvidence => ({
    id,
    title,
    source: `${uiCapabilityEvidence.source}; ${apiCapabilityEvidence.source}`,
    state: apiCapabilityEvidence.state === 'connected' && uiCapabilityEvidence.state === 'connected'
      ? 'connected'
      : apiCapabilityEvidence.state === 'gap' && uiCapabilityEvidence.state === 'gap' ? 'gap' : 'partial',
    matchedKeywords: uniqueSorted([...apiCapabilityEvidence.matchedKeywords, ...uiCapabilityEvidence.matchedKeywords]),
  });
  const casperCommerceCapabilities = [
    flow('auth-flow', 'Authenticate customer', casperApiCapabilities[0], authUi),
    flow('catalog-flow', 'Browse catalog and product detail', casperApiCapabilities[2], catalogUi),
    flow('order-flow', 'Create customer order', ordersApi, checkoutUi),
    flow('payment-flow', 'Complete and confirm payment', paymentsApi, checkoutUi),
    flow('order-history-flow', 'Inspect order history and status', ordersApi, ordersUi),
  ];

  return { casperApiCapabilities, casperUiCapabilities, casperCommerceCapabilities };
}

function fileContentsByPath(files: FileRecord[]): Map<string, string> {
  return new Map(files.map((file) => [file.relativePath, file.content]));
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
  const composables = buildComposableIndex(files);
  const byId = new Map<string, BackofficeSurfaceEvidence>();

  for (const file of pageFiles) {
    const id = surfaceIdFromPage(file.relativePath);
    if (!id) continue;
    byId.set(id, surfaceFromFile(id, file, composables));
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

function surfaceFromFile(id: string, file: FileRecord, composables: Map<string, string>): BackofficeSurfaceEvidence {
  // A manage page is mostly template markup; its real wiring and any remaining
  // mock/local-only persistence live in the composables it calls. Evaluate the
  // page together with those composables so a clean-looking page backed by a
  // mock composable is scored 'partial', not a false 'connected'.
  const referenced = referencedComposableContents(file.content, composables);
  const combined = [file.content, ...referenced].join('\n');
  const apiPaths = extractApiPaths(file.content, true);
  const hasApi = API_WIRING_PATTERN.test(combined);
  const hasGap = hasMockGapEvidence(combined);
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

export function hasMockGapEvidence(content: string): boolean {
  return MOCK_GAP_PATTERN.test(content);
}

function buildComposableIndex(files: FileRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of files) {
    const match = file.relativePath.match(/^app\/composables\/(use[A-Za-z0-9]+)\.ts$/);
    if (match) index.set(match[1], file.content);
  }
  return index;
}

function referencedComposableContents(content: string, composables: Map<string, string>): string[] {
  const names = new Set(content.match(/\buse[A-Z][A-Za-z0-9]*/g) || []);
  const contents: string[] = [];
  for (const name of names) {
    const composableContent = composables.get(name);
    if (composableContent) contents.push(composableContent);
  }
  return contents;
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
  if (lower.includes('vip-level') || lower.includes('/vip') || lower.includes('/levels') || lower.includes('/group/level')) return { id: 'vip-levels', label: 'VIP Levels' };
  if (lower.includes('/game') || lower.includes('/category')) return { id: 'games', label: 'Games / Categories' };
  if (lower.includes('order-packages') || lower.includes('/store') || lower.includes('rate-catalog')) return { id: 'store', label: 'Store / Exchange' };
  if (lower.includes('/missions') || lower.includes('/weekly') || lower.includes('/daily') || lower.includes('check-in')) return { id: 'missions', label: 'Missions / Check-in' };
  if (lower.includes('redemption')) return { id: 'redemption', label: 'Redemption' };
  if (lower.includes('/provider')) return { id: 'providers', label: 'Providers' };
  if (lower.includes('/wallet')) return { id: 'wallet', label: 'Wallet' };
  if (lower.includes('/user') || lower.includes('/player')) return { id: 'players', label: 'Players' };
  if (lower.includes('/uploads')) return { id: 'uploads', label: 'Uploads' };
  return null;
}

function extractApiPaths(content: string, adminOnly: boolean): string[] {
  const matches = content.match(API_PATTERN) || [];
  return uniqueSorted(matches
    .map(normalizeApiPath)
    .filter((apiPath) => adminOnly ? apiPath.startsWith('/api/v1/admin/') : !apiPath.startsWith('/api/v1/admin/')));
}

export function normalizeApiPath(apiPath: string): string {
  return apiPath
    .split(/[?#]/)[0]
    .replace(/[),.;'">`]+$/g, '')
    .split('/')
    .map((segment) => (isParamSegment(segment) ? '{}' : segment))
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

// A URL segment is a path parameter regardless of how the source spells it:
// backend contract `{activityId}` / `{activity_id}`, Nuxt route `:id`, or a
// frontend template interpolation `${...}` (possibly truncated by API_PATTERN
// at the first char it does not capture, e.g. `${encodeURIComponent(`).
// Collapsing them all to `{}` lets frontend usage match the backend contract.
function isParamSegment(segment: string): boolean {
  if (!segment) return false;
  return segment.startsWith(':') || segment.startsWith('$') || segment.includes('{');
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
