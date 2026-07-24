import React, { useState } from 'react';
import { apiErrorRetryAfterSeconds, apiErrorStatus } from '../httpError';

interface CodeEntryApi {
  exchangeCode: (code: string) => Promise<unknown>;
}

interface CodeEntryProps {
  api: CodeEntryApi;
  onAuthenticated: () => void;
}

export function CodeEntry({ api, onAuthenticated }: CodeEntryProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.exchangeCode(trimmed);
      onAuthenticated();
    } catch (err) {
      setError(describeExchangeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="intake-card intake-code-card">
      <h1 className="intake-code-title">Enter your intake code</h1>
      <p className="intake-code-copy">
        Enter the one-time code you were given to report an issue.
      </p>
      <form className="intake-code-form" onSubmit={handleSubmit}>
        <label className="dialog-label" htmlFor="intake-code-input">Code</label>
        <input
          id="intake-code-input"
          className="form-input"
          type="text"
          inputMode="text"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. ABCD-1234"
          disabled={submitting}
        />
        {error && <div className="dialog-error" role="alert">{error}</div>}
        <button
          type="submit"
          className="form-button-primary intake-code-submit"
          disabled={submitting || !code.trim()}
        >
          {submitting ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}

function describeExchangeError(err: unknown): string {
  const status = apiErrorStatus(err);
  if (status === 401) return 'Invalid code.';
  if (status === 429) {
    const retryAfter = apiErrorRetryAfterSeconds(err);
    return retryAfter
      ? `Too many attempts, try again in ${retryAfter}s.`
      : 'Too many attempts, try again shortly.';
  }
  return 'Something went wrong. Please try again.';
}
