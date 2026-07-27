import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  KnowledgeFindingPriorityCounts,
  KnowledgeReviewDetail,
  KnowledgeReviewsResponse,
  KnowledgeReviewSummary,
} from '@shared/types';

export const KNOWLEDGE_REVIEW_ID_PATTERN = /^KLR-[0-9]{8}T[0-9]{6}Z-[a-z0-9][a-z0-9-]*$/;

const execFileAsync = promisify(execFile);
const VALIDATION_CONCURRENCY = 4;

type CanonicalValidatorResponse =
  | { valid: true; review: KnowledgeReviewDetail }
  | { valid: false; errors: string[] };

class InvalidKnowledgeReviewError extends Error {}

type LoadedReview = { file: string; review: KnowledgeReviewDetail };
type LoadAllResult = { reviews: KnowledgeReviewDetail[]; invalidFiles: string[] };
type CachedReview = {
  fileSignature: string;
  policySignature: string | null;
  review: KnowledgeReviewDetail;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function parseValidatorResponse(source: string): CanonicalValidatorResponse {
  const result: unknown = JSON.parse(source);
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as { valid?: unknown }).valid !== 'boolean') {
    throw new Error('canonical knowledge review validator returned an invalid response');
  }
  return result as CanonicalValidatorResponse;
}

async function loadCanonicalReview(
  filePath: string,
  validatorPath: string,
  workspaceRoot?: string,
): Promise<KnowledgeReviewDetail> {
  const env = workspaceRoot
    ? { ...process.env, AI_OFFICE_REPO_ROOT: workspaceRoot }
    : process.env;

  try {
    const { stdout } = await execFileAsync('ruby', [validatorPath, '--json', filePath], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    });
    const response = parseValidatorResponse(stdout);
    if (!response.valid || !response.review || typeof response.review !== 'object') {
      throw new Error('canonical knowledge review validator omitted the normalized review');
    }
    return response.review;
  } catch (error) {
    const processError = error as { code?: unknown; stdout?: unknown };
    if (processError.code === 1 && typeof processError.stdout === 'string' && processError.stdout) {
      const response = parseValidatorResponse(processError.stdout);
      if (!response.valid && Array.isArray(response.errors)) {
        throw new InvalidKnowledgeReviewError(response.errors.join('; '));
      }
    }
    throw error;
  }
}

function countPriorities(findings: KnowledgeReviewDetail['findings']): KnowledgeFindingPriorityCounts {
  const counts: KnowledgeFindingPriorityCounts = {};
  for (const finding of findings) {
    counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
  }
  return counts;
}

function toSummary(review: KnowledgeReviewDetail): KnowledgeReviewSummary {
  const { authorization: _authorization, notesReviewed: _notesReviewed, findings, changes: _changes, ...summary } = review;
  return { ...summary, priorityCounts: countPriorities(findings) };
}

export class KnowledgeReviewService {
  private readonly validatorPath: string;
  private readonly schemaPath: string;
  private readonly cache = new Map<string, CachedReview>();
  private contractSignature: string | null = null;
  private pendingLoad: Promise<LoadAllResult> | null = null;

  constructor(
    private readonly reviewsDir: string,
    private readonly workspaceRoot?: string,
    validatorPath?: string,
  ) {
    this.validatorPath = validatorPath ?? path.join(path.dirname(reviewsDir), 'scripts', 'validate-knowledge-librarian.rb');
    this.schemaPath = path.join(path.dirname(reviewsDir), 'schemas', 'knowledge-librarian-output.schema.json');
  }

  private async signature(filePath: string): Promise<string> {
    try {
      const stats = await fs.stat(filePath);
      return `${stats.size}:${stats.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  private async currentContractSignature(): Promise<string> {
    const [validator, schema] = await Promise.all([
      this.signature(this.validatorPath),
      this.signature(this.schemaPath),
    ]);
    return `${validator}|${schema}`;
  }

  private async policySignature(review: KnowledgeReviewDetail): Promise<string | null> {
    const source = review.authorization?.policySource;
    if (!source) return null;
    const root = this.workspaceRoot ?? path.resolve(path.dirname(this.validatorPath), '../..');
    return this.signature(path.resolve(root, source));
  }

  private async loadAllUncached(): Promise<LoadAllResult> {
    let entries;
    try {
      entries = await fs.readdir(this.reviewsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { reviews: [], invalidFiles: [] };
      }
      throw error;
    }

    const contractSignature = await this.currentContractSignature();
    if (this.contractSignature !== contractSignature) {
      this.cache.clear();
      this.contractSignature = contractSignature;
    }

    const candidates = (await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
        .map(async (entry) => {
          const filePath = path.join(this.reviewsDir, entry.name);
          const fileSignature = await this.signature(filePath);
          return fileSignature === 'missing'
            ? null
            : { file: entry.name, filePath, fileSignature };
        }),
    )).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

    const liveFiles = new Set(candidates.map(({ file }) => file));
    for (const file of this.cache.keys()) {
      if (!liveFiles.has(file)) this.cache.delete(file);
    }

    const loaded: LoadedReview[] = [];
    const invalidFiles: string[] = [];
    const misses = [];
    for (const candidate of candidates) {
      const cached = this.cache.get(candidate.file);
      if (cached && cached.fileSignature === candidate.fileSignature) {
        const currentPolicySignature = await this.policySignature(cached.review);
        if (currentPolicySignature === cached.policySignature) {
          loaded.push({ file: candidate.file, review: cached.review });
          continue;
        }
      }
      misses.push(candidate);
    }

    const validated = await mapWithConcurrency(misses, VALIDATION_CONCURRENCY, async (candidate) => {
      try {
        const review = await loadCanonicalReview(candidate.filePath, this.validatorPath, this.workspaceRoot);
        const policySignature = await this.policySignature(review);
        this.cache.set(candidate.file, {
          fileSignature: candidate.fileSignature,
          policySignature,
          review,
        });
        return { file: candidate.file, review };
      } catch (error) {
        if (!(error instanceof InvalidKnowledgeReviewError)) throw error;
        this.cache.delete(candidate.file);
        return { file: candidate.file, review: null };
      }
    });
    for (const result of validated) {
      if (result.review) loaded.push({ file: result.file, review: result.review });
      else invalidFiles.push(result.file);
    }

    const reviewIdCounts = new Map<string, number>();
    loaded.forEach(({ review }) => reviewIdCounts.set(review.reviewId, (reviewIdCounts.get(review.reviewId) ?? 0) + 1));
    const reviews = loaded
      .filter(({ file, review }) => {
        if ((reviewIdCounts.get(review.reviewId) ?? 0) === 1) return true;
        invalidFiles.push(file);
        return false;
      })
      .map(({ review }) => review);

    reviews.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
    invalidFiles.sort();
    return { reviews, invalidFiles };
  }

  private async loadAll(): Promise<LoadAllResult> {
    if (this.pendingLoad) return this.pendingLoad;
    this.pendingLoad = this.loadAllUncached();
    try {
      return await this.pendingLoad;
    } finally {
      this.pendingLoad = null;
    }
  }

  async list(): Promise<KnowledgeReviewsResponse> {
    const { reviews, invalidFiles } = await this.loadAll();
    return {
      generatedAt: new Date().toISOString(),
      total: reviews.length,
      invalidCount: invalidFiles.length,
      invalidFiles,
      reviews: reviews.map(toSummary),
    };
  }

  async getById(reviewId: string): Promise<KnowledgeReviewDetail | null> {
    if (!KNOWLEDGE_REVIEW_ID_PATTERN.test(reviewId)) return null;
    const { reviews } = await this.loadAll();
    return reviews.find((review) => review.reviewId === reviewId) ?? null;
  }
}
