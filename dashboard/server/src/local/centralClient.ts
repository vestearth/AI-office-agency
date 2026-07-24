// Local-side Central API client (Phase B). Every call sends the admin bearer
// token in the Authorization header, never in a URL/query string
// (Decision #1: capability-based, not URL-trust). fetchImpl is injectable so
// tests never make a real network call.

type FetchImpl = typeof fetch;

export function makeCentralClient(opts: { baseUrl: string; adminToken: string; fetchImpl?: FetchImpl }) {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${opts.adminToken}`, 'content-type': 'application/json' };

  async function req(method: string, pathPart: string, body?: unknown): Promise<any> {
    const res = await f(`${base}${pathPart}`, {
      method,
      headers: auth,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Central ${method} ${pathPart} -> ${res.status} ${text}`);
    }
    return res.json().catch(() => ({}));
  }

  return {
    // Read-only (Decision #14): fetches changes since the given cursor. The
    // cursor is not a secret, so it is fine in the query string.
    getChanges: (since: number) => req('GET', `/api/intake/changes?since=${encodeURIComponent(since)}`),
    getIntakeDetail: (id: string) => req('GET', `/api/intake/admin/intakes/${encodeURIComponent(id)}`),
    claim: (intakeId: string, owner: string, expectedRevision: number) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/claim`, { owner, expectedRevision }),
    renewClaim: (intakeId: string, claimId: string, owner: string) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/claim/renew`, { claimId, owner }),
    releaseClaim: (intakeId: string, claimId: string, owner: string) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/claim/release`, { claimId, owner }),
    importTriage: (intakeId: string, body: object) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/triage`, body),
    recordPromotion: (intakeId: string, body: object) =>
      req('POST', `/api/intake/intakes/${encodeURIComponent(intakeId)}/promotion`, body),
  };
}
