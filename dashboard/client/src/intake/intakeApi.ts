// Tester-facing Intake Board API client.
//
// Session auth is a same-origin cookie (`intake_sid`) set by the server on
// `exchangeCode`; there is no bearer token here (unlike the admin `src/api.ts`).
// The CSRF token is deliberately kept in memory only — never localStorage,
// never the URL — since it (and the tester code) must not survive a page
// reload or leak into browser history/logs.

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
      let detail = '';
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        // ignore — non-JSON error body
      }
      throw new Error(`${method} ${path} failed: ${res.status} ${detail}`);
    }

    return res.json();
  }

  return {
    async exchangeCode(code: string) {
      const res = await req('POST', '/api/intake/session', { body: { code } });
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
