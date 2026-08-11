// Tester-facing Intake Board API client.
//
// Session auth is a same-origin cookie (`intake_sid`) set by the server on
// `exchangeCode`; there is no bearer token here (unlike the admin `src/api.ts`).
// The CSRF token is deliberately kept in memory only — never localStorage or
// the URL. After a page reload it is reacquired from the authenticated session
// endpoint, so it does not leak into browser history/logs.

export function newIdempotencyKey(): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let inMemoryCsrf = '';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface IntakeApiOptions {
  fetchImpl?: typeof fetch;
  getCsrf?: () => string;
  setCsrf?: (token: string) => void;
}

export interface RequestOptions {
  body?: unknown;
  raw?: BodyInit;
  filename?: string;
}

export interface TesterSession {
  csrfToken: string;
  expiresAt: number;
  testerLabel: string;
}

// Thrown by `req()` on a non-ok response. Carries the HTTP status and (when
// the server sent one, e.g. code-exchange/submission/upload rate limits) the
// `Retry-After` value in seconds, so callers can branch on status without
// re-parsing `.message`. `.message` is kept human-readable for logging.
export class IntakeApiError extends Error {
  status: number;
  retryAfterSeconds?: number;
  body?: unknown;

  constructor(message: string, status: number, opts: { retryAfterSeconds?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'IntakeApiError';
    this.status = status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.body = opts.body;
  }
}

export function makeIntakeApi(opts: IntakeApiOptions = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const getCsrf = opts.getCsrf ?? (() => inMemoryCsrf);
  const setCsrf = opts.setCsrf ?? ((t: string) => { inMemoryCsrf = t; });

  async function req(method: string, path: string, { body, raw, filename }: RequestOptions = {}) {
    const headers: Record<string, string> = {};
    let requestBody: BodyInit | undefined;

    if (raw !== undefined) {
      requestBody = raw;
      if (filename !== undefined) headers['X-Filename'] = filename;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }

    if (UNSAFE_METHODS.has(method)) {
      headers['X-CSRF-Token'] = getCsrf();
    }

    const res = await fetchImpl(path, {
      method,
      credentials: 'include',
      headers,
      body: requestBody,
    });

    if (!res.ok) {
      let body: any;
      let detail = '';
      try {
        body = await res.json();
        detail = JSON.stringify(body);
      } catch {
        // ignore — non-JSON error body
      }
      const retryAfterHeader = res.headers?.get?.('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      throw new IntakeApiError(`${method} ${path} failed: ${res.status} ${detail}`, res.status, {
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        body,
      });
    }

    return res.json();
  }

  return {
    async resumeSession() {
      const res = await req('GET', '/api/intake/session') as TesterSession;
      setCsrf(res.csrfToken);
      return res;
    },

    async exchangeCode(code: string) {
      const res = await req('POST', '/api/intake/session', { body: { code } }) as TesterSession;
      setCsrf(res.csrfToken);
      return res;
    },

    async submitIntake(body: unknown) {
      return req('POST', '/api/intake/intakes', { body });
    },

    async listIntakes() {
      return req('GET', '/api/intake/intakes');
    },

    async getProducts() {
      return req('GET', '/api/intake/products');
    },

    async uploadAttachment(id: string, file: File | Blob) {
      const filename = (file as File).name ?? 'attachment';
      return req('POST', `/api/intake/intakes/${encodeURIComponent(id)}/attachments`, {
        raw: file,
        filename,
      });
    },

    async logout() {
      return req('DELETE', '/api/intake/session');
    },
  };
}

export type IntakeApi = ReturnType<typeof makeIntakeApi>;
