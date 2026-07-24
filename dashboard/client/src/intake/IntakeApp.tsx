import React, { useMemo, useRef, useState } from 'react';
import '../styles/globals.css';
import { makeIntakeApi, type IntakeApi } from './intakeApi';
import { apiErrorStatus } from './httpError';
import { ToastProvider, useToast } from '../components/Toast';
import { CodeEntry } from './components/CodeEntry';
import { IntakeForm } from './components/IntakeForm';
import { MyIntakes } from './components/MyIntakes';

type AuthState = 'unauthenticated' | 'authenticated';

// Wraps every intakeApi method so a 401 from ANY call (not just exchangeCode)
// resets the app to `unauthenticated` — per the brief's state machine. Still
// rethrows so the calling component's own catch (e.g. CodeEntry's "Invalid
// code" message) runs too.
function withAuthGuard(api: IntakeApi, onUnauthorized: () => void): IntakeApi {
  const wrapped = {} as IntakeApi;
  (Object.keys(api) as (keyof IntakeApi)[]).forEach((key) => {
    const fn = api[key] as (...args: unknown[]) => Promise<unknown>;
    (wrapped as Record<string, unknown>)[key as string] = async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (err) {
        if (apiErrorStatus(err) === 401) onUnauthorized();
        throw err;
      }
    };
  });
  return wrapped;
}

function IntakeAppShell() {
  const toast = useToast();
  const rawApiRef = useRef<IntakeApi>();
  if (!rawApiRef.current) rawApiRef.current = makeIntakeApi();

  const [authState, setAuthState] = useState<AuthState>('unauthenticated');
  const [refreshToken, setRefreshToken] = useState(0);

  const api = useMemo(
    () => withAuthGuard(rawApiRef.current!, () => setAuthState('unauthenticated')),
    [],
  );

  function handleLogout() {
    api.logout()
      .catch(() => { /* best-effort — reset locally regardless */ })
      .finally(() => setAuthState('unauthenticated'));
  }

  return (
    <div className="intake-page">
      <header className="intake-header">
        <div className="intake-header-title">Report an Issue</div>
        {authState === 'authenticated' && (
          <button type="button" className="form-button" onClick={handleLogout}>Log out</button>
        )}
      </header>
      <main className="intake-main">
        {authState === 'unauthenticated' ? (
          <CodeEntry api={api} onAuthenticated={() => setAuthState('authenticated')} />
        ) : (
          <div className="intake-authenticated-layout">
            <IntakeForm
              api={api}
              onSubmitted={() => setRefreshToken((n) => n + 1)}
              onNotice={(message, tone) => toast.show(message, tone)}
            />
            <MyIntakes api={api} refreshToken={refreshToken} />
          </div>
        )}
      </main>
    </div>
  );
}

export function IntakeApp() {
  return (
    <ToastProvider>
      <IntakeAppShell />
    </ToastProvider>
  );
}
