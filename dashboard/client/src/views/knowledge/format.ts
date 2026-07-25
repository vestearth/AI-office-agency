import type {
  KnowledgeFindingPriority,
  KnowledgeFindingPriorityCounts,
  KnowledgeReviewFinding,
} from '../../../../shared/types';

// Words the generator emits lower-case that must not be title-cased into "Vip".
const ACRONYMS = new Set([
  'adr', 'ai', 'api', 'bc', 'ci', 'cli', 'css', 'db', 'id', 'kb', 'pr',
  'qa', 'sdk', 'ui', 'url', 'ux', 'vip', 'vps', 'yaml',
]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const PRIORITY_ORDER: KnowledgeFindingPriority[] = ['critical', 'high', 'medium', 'low'];

export const OTHER_PATH_GROUP = 'Other';

export interface ScopePathGroup {
  root: string;
  paths: string[];
}

export function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (ACRONYMS.has(word.toLowerCase())
      ? word.toUpperCase()
      : word.replace(/^./, (char) => char.toUpperCase())))
    .join(' ');
}

export function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function reviewSlug(reviewId: string): string {
  return reviewId.replace(/^KLR-[0-9]{8}T[0-9]{6}Z-/, '');
}

export function reviewTitle(reviewId: string, product: string): string {
  return humanizeLabel(reviewSlug(reviewId) || product);
}

// The generator has no controlled vocabulary for scope.product, so two thirds of
// rows repeat the title verbatim. Show the product only when it adds something.
export function shouldShowProduct(product: string, title: string): boolean {
  const normalizedProduct = normalizeLabel(product);
  const normalizedTitle = normalizeLabel(title);
  if (!normalizedProduct) return false;
  if (!normalizedTitle) return true;
  return !normalizedTitle.includes(normalizedProduct) && !normalizedProduct.includes(normalizedTitle);
}

// scope.paths is not guaranteed to hold paths — the corpus also carries commit
// SHAs, PR references and prose. Anything unrooted keeps its verbatim text in a
// trailing catch-all rather than being dropped or mangled into a fake group.
export function groupPathsByRoot(paths: string[]): ScopePathGroup[] {
  const groups = new Map<string, string[]>();

  for (const entry of paths) {
    const segments = entry.split('/');
    const root = segments[0];
    const rooted = segments.length > 1 && root.trim() !== '' && !root.endsWith(':');
    const key = rooted ? root : OTHER_PATH_GROUP;
    const value = rooted ? segments.slice(1).join('/') : entry;
    const bucket = groups.get(key);
    if (bucket) bucket.push(value);
    else groups.set(key, [value]);
  }

  return [...groups.entries()]
    .map(([root, grouped]) => ({ root, paths: grouped }))
    .sort((a, b) => {
      if (a.root === OTHER_PATH_GROUP) return 1;
      if (b.root === OTHER_PATH_GROUP) return -1;
      return b.paths.length - a.paths.length;
    });
}

export function reviewRepos(paths: string[]): string[] {
  return groupPathsByRoot(paths)
    .filter((group) => group.root !== OTHER_PATH_GROUP)
    .map((group) => group.root);
}

export function maxPriority(counts: KnowledgeFindingPriorityCounts | undefined): KnowledgeFindingPriority | null {
  if (!counts) return null;
  return PRIORITY_ORDER.find((priority) => (counts[priority] ?? 0) > 0) ?? null;
}

export function sortFindingsByPriority(findings: KnowledgeReviewFinding[]): KnowledgeReviewFinding[] {
  return [...findings].sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
  );
}

// Renders in the viewer's local timezone, deliberately: every other timestamp
// in this dashboard uses toLocaleString/toLocaleDateString, including the
// "Generated" line that sits beside this one in the detail header. That makes
// the absolute branch host-dependent, so the suite pins TZ=UTC to stay
// deterministic — see the client's test script.
export function formatReviewDate(iso: string, now: Date = new Date()): string {
  const timestamp = new Date(iso);
  if (!Number.isFinite(timestamp.getTime())) return iso;

  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - timestamp.getTime()) / 60_000));
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 48) return `${elapsedHours}h ago`;

  const day = timestamp.getDate();
  const month = MONTHS[timestamp.getMonth()];
  return timestamp.getFullYear() === now.getFullYear()
    ? `${day} ${month}`
    : `${day} ${month} ${timestamp.getFullYear()}`;
}

export function formatReviewDateTime(iso: string): string {
  const timestamp = new Date(iso);
  if (!Number.isFinite(timestamp.getTime())) return iso;

  const day = timestamp.getDate();
  const month = MONTHS[timestamp.getMonth()];
  const hours = String(timestamp.getHours()).padStart(2, '0');
  const minutes = String(timestamp.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${timestamp.getFullYear()}, ${hours}:${minutes}`;
}
