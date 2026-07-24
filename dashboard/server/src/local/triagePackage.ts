import crypto from 'crypto';
import { TRIAGE_SCHEMA_VERSION } from '../intake/triageSchema';
import type { Provenance } from './repoProvenance';

export interface TriageManifest {
  intake: { id: string; title: string; body: string; productHint: string | null; revision: number };
  repos: string[];
  provenance: Provenance[];
  approvedSnippets: { repo: string; path: string; excerpt: string }[];
  promptSchemaVersion: string;
  expectedResultSchema: string;
}

export function buildTriagePackage(input: {
  intake: { id: string; title: string; body: string; product_hint: string | null; revision: number };
  repos: string[];
  provenance: Provenance[];
  approvedSnippets?: { repo: string; path: string; excerpt: string }[];
}): { manifest: TriageManifest; contextHash: string; promptSchemaVersion: string } {
  if (!input.repos.length) {
    throw new Error('needs_scope_review: cannot build a triage package with no allowlisted repos');
  }
  // DATA only — attachments/images are intentionally excluded (Decision #7/#10).
  const manifest: TriageManifest = {
    intake: {
      id: input.intake.id, title: input.intake.title, body: input.intake.body,
      productHint: input.intake.product_hint, revision: input.intake.revision,
    },
    repos: input.repos,
    provenance: input.provenance,
    approvedSnippets: input.approvedSnippets ?? [],
    promptSchemaVersion: TRIAGE_SCHEMA_VERSION,
    expectedResultSchema: TRIAGE_SCHEMA_VERSION,
  };
  // Stable hash over a canonical JSON serialization (deep-sorted keys).
  // NOTE: a JSON.stringify(obj, Object.keys(obj).sort()) replacer array only
  // allowlists TOP-LEVEL keys — nested objects (intake, provenance entries)
  // would collapse to `{}` and the hash would stop reflecting their content.
  // canonicalize() below sorts keys recursively so the hash is sensitive to
  // every field at every depth, while still being independent of insertion
  // order.
  const canonical = JSON.stringify(canonicalize(manifest));
  const contextHash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return { manifest, contextHash, promptSchemaVersion: TRIAGE_SCHEMA_VERSION };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) result[key] = canonicalize((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}
