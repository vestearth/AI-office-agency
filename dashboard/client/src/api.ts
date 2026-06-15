// Centralized API client. Injects the shared bearer token into every request
// so the dashboard works against an auth-protected server (DASHBOARD_AUTH_TOKEN).

const TOKEN_KEY = 'dashboard_token';

// null = not yet resolved this session. An empty string is a valid resolved
// value meaning "user dismissed / auth disabled" — so we don't re-prompt.
let cachedToken: string | null = null;

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function persistToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Ignore storage failures so unsupported runtimes still render the UI.
  }
}

function requestToken(): string {
  try {
    return (window.prompt('Enter dashboard access token (leave blank if auth is disabled):') || '').trim();
  } catch {
    return '';
  }
}

export function getToken(): string {
  if (cachedToken !== null) {
    return cachedToken;
  }

  let token = readStoredToken();
  if (token === null) {
    token = requestToken();
    // Persist even when blank so we remember the choice across reloads.
    persistToken(token);
  }

  cachedToken = token;
  return token;
}

export function clearToken(): void {
  cachedToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage failures so token reset never crashes the dashboard.
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...init, headers });

  // A rejected token is likely stale/wrong — forget it so the next call re-prompts.
  if (res.status === 401) {
    clearToken();
  }

  return res;
}

export async function apiFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(errorData.error || `HTTP error! status: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface IdentityResponse {
  taskPrefix: string | null;
  source: 'local-config' | 'base-config' | null;
  owner?: string | null;
  conflict?: { prefix: string; owner: string } | null;
  written: boolean;
  registryUpdated?: boolean;
}

// Reports the dashboard display name to the server, which derives and
// persists a per-machine task prefix (TASK-<PREFIX>-NNN intake namespace)
// when none is configured yet. Returns null on any failure — identity sync
// is best-effort and must never break the decision flow.
export async function syncIdentity(actor: string): Promise<IdentityResponse | null> {
  try {
    if (!actor.trim()) {
      return await apiFetchJson<IdentityResponse>('/api/identity');
    }
    return await apiFetchJson<IdentityResponse>('/api/identity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: actor.trim() }),
    });
  } catch {
    return null;
  }
}

// EventSource cannot set headers, so the token rides as a query param instead.
export function apiEventSourceUrl(path: string): string {
  const token = getToken();
  if (!token) {
    return path;
  }
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}
