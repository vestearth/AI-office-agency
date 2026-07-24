import { apiFetchJson } from '../api';
import type { ReviewIntakeSummary, ReviewIntakeDetail } from '../../../shared/types';

const post = (path: string, body: object) => apiFetchJson(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

export const reviewApi = {
  listIntakes: (state?: string, includeClosed = false) =>
    apiFetchJson<{ intakes: ReviewIntakeSummary[]; counts: Record<string, number> }>(
      `/api/intake/review/intakes?${new URLSearchParams({ ...(state ? { state } : {}), includeClosed: String(includeClosed) })}`),
  getDetail: (id: string) => apiFetchJson<ReviewIntakeDetail>(`/api/intake/review/intakes/${id}`),
  claim: (id: string, expectedRevision: number) => post(`/api/intake/review/intakes/${id}/claim`, { expectedRevision }),
  release: (id: string) => post(`/api/intake/review/intakes/${id}/release`, {}),
  triagePackage: (id: string) => post(`/api/intake/review/intakes/${id}/triage-package`, {}),
  recordTriage: (id: string, expectedRevision: number, result: object) => post(`/api/intake/review/intakes/${id}/triage-result`, { expectedRevision, result }),
  promote: (id: string, expectedRevision: number, prefix: string, overrideReason?: string) => post(`/api/intake/review/intakes/${id}/promote`, { expectedRevision, prefix, overrideReason }),
};
