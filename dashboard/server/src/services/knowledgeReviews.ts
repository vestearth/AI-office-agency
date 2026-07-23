import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  KnowledgeReviewDetail,
  KnowledgeReviewsResponse,
  KnowledgeReviewSummary,
} from '@shared/types';

export const KNOWLEDGE_REVIEW_ID_PATTERN = /^KLR-[0-9]{8}T[0-9]{6}Z-[a-z0-9][a-z0-9-]*$/;

const execFileAsync = promisify(execFile);

type CanonicalValidatorResponse =
  | { valid: true; review: KnowledgeReviewDetail }
  | { valid: false; errors: string[] };

class InvalidKnowledgeReviewError extends Error {}

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

function toSummary(review: KnowledgeReviewDetail): KnowledgeReviewSummary {
  const { authorization: _authorization, notesReviewed: _notesReviewed, findings: _findings, changes: _changes, ...summary } = review;
  return summary;
}

export class KnowledgeReviewService {
  private readonly validatorPath: string;

  constructor(
    private readonly reviewsDir: string,
    private readonly workspaceRoot?: string,
    validatorPath?: string,
  ) {
    this.validatorPath = validatorPath ?? path.join(path.dirname(reviewsDir), 'scripts', 'validate-knowledge-librarian.rb');
  }

  private async loadAll(): Promise<{ reviews: KnowledgeReviewDetail[]; invalidFiles: string[] }> {
    let entries;
    try {
      entries = await fs.readdir(this.reviewsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { reviews: [], invalidFiles: [] };
      }
      throw error;
    }

    const loaded: Array<{ file: string; review: KnowledgeReviewDetail }> = [];
    const invalidFiles: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      try {
        loaded.push({
          file: entry.name,
          review: await loadCanonicalReview(
            path.join(this.reviewsDir, entry.name),
            this.validatorPath,
            this.workspaceRoot,
          ),
        });
      } catch (error) {
        if (!(error instanceof InvalidKnowledgeReviewError)) throw error;
        invalidFiles.push(entry.name);
      }
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
