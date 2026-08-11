import React, { useEffect, useRef, useState } from 'react';
import { newIdempotencyKey } from '../intakeApi';
import { apiErrorRetryAfterSeconds, apiErrorStatus } from '../httpError';

// Sentinel for the "Other / not sure" option — never sent to the server.
// Selecting it submits an EMPTY productHint; there is no free-text product
// field in v1 (see task-9 brief + server config.ts intakeProductList comment).
const OTHER_VALUE = '__other__';

const SEVERITIES = ['blocker', 'high', 'medium', 'low'] as const;

interface ProductOption {
  value: string;
  label: string;
}

interface IntakeFormApi {
  getProducts: () => Promise<{ products: ProductOption[] }>;
  submitIntake: (body: unknown) => Promise<{ id: string }>;
  uploadAttachment: (id: string, file: File | Blob) => Promise<unknown>;
}

interface IntakeFormProps {
  api: IntakeFormApi;
  onSubmitted: () => void;
  onNotice: (message: string, tone: 'success' | 'error') => void;
}

const emptyFields = {
  title: '',
  product: OTHER_VALUE,
  severity: '',
  body: '',
  reproSteps: '',
  expected: '',
  actual: '',
  environment: '',
};

export function IntakeForm({ api, onSubmitted, onNotice }: IntakeFormProps) {
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [fields, setFields] = useState(emptyFields);
  const [moreOpen, setMoreOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.getProducts()
      .then((res) => { if (!cancelled) setProducts(res.products ?? []); })
      .catch(() => { if (!cancelled) setProductsError('Could not load the product list — you can still pick "Other / not sure".'); });
    return () => { cancelled = true; };
  }, [api]);

  function updateField<K extends keyof typeof emptyFields>(key: K, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const title = fields.title.trim();
    const body = fields.body.trim();
    if (!title || !body) {
      setFormError('Title and description are required.');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const created = await api.submitIntake({
        title,
        body,
        productHint: fields.product === OTHER_VALUE ? '' : fields.product,
        severity: fields.severity || undefined,
        reproSteps: fields.reproSteps.trim() || undefined,
        expected: fields.expected.trim() || undefined,
        actual: fields.actual.trim() || undefined,
        environment: fields.environment.trim() || undefined,
        idempotencyKey: newIdempotencyKey(),
      });

      const files = fileInputRef.current?.files ? Array.from(fileInputRef.current.files) : [];
      const uploadFailures: string[] = [];
      for (const file of files) {
        try {
          await api.uploadAttachment(created.id, file);
        } catch (err) {
          uploadFailures.push(`${file.name} (${describeUploadError(err)})`);
        }
      }

      setFields(emptyFields);
      setMoreOpen(false);
      if (fileInputRef.current) fileInputRef.current.value = '';

      onNotice(
        uploadFailures.length
          ? `Intake submitted, but some attachments failed to upload: ${uploadFailures.join(', ')}.`
          : 'Intake submitted. Thanks!',
        uploadFailures.length ? 'error' : 'success',
      );
      onSubmitted();
    } catch (err) {
      setFormError(describeSubmitError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="intake-card intake-form" onSubmit={handleSubmit}>
      <div className="intake-section-heading">
        <span className="intake-section-kicker">New report</span>
        <h2 className="intake-form-title">Tell us what happened</h2>
        <p>Share the essentials first. You can add technical details when they help reproduce the issue.</p>
      </div>

      <div className="intake-field">
        <label className="dialog-label" htmlFor="intake-title">
          Title <span className="dialog-required">required</span>
        </label>
        <input
          id="intake-title"
          className="form-input"
          value={fields.title}
          onChange={(e) => updateField('title', e.target.value)}
          placeholder="Short summary of the issue"
          disabled={submitting}
        />
      </div>

      <div className="intake-field-row">
        <div className="intake-field">
          <label className="dialog-label" htmlFor="intake-product">Product</label>
          <select
            id="intake-product"
            className="form-input"
            value={fields.product}
            onChange={(e) => updateField('product', e.target.value)}
            disabled={submitting}
          >
            {products.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
            <option value={OTHER_VALUE}>Other / not sure</option>
          </select>
          {productsError && <div className="dialog-error">{productsError}</div>}
        </div>

        <div className="intake-field">
          <label className="dialog-label" htmlFor="intake-severity">
            Severity <span className="dialog-optional">optional</span>
          </label>
          <select
            id="intake-severity"
            className="form-input"
            value={fields.severity}
            onChange={(e) => updateField('severity', e.target.value)}
            disabled={submitting}
          >
            <option value="">Not sure</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="intake-field">
        <label className="dialog-label" htmlFor="intake-body">
          Description <span className="dialog-required">required</span>
        </label>
        <textarea
          id="intake-body"
          className="form-input dialog-textarea"
          rows={5}
          value={fields.body}
          onChange={(e) => updateField('body', e.target.value)}
          placeholder="What happened? What did you expect to happen instead?"
          disabled={submitting}
        />
      </div>

      <details
        className="intake-more"
        open={moreOpen}
        onToggle={(e) => setMoreOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="intake-more-summary">More details (optional)</summary>
        <div className="intake-more-body">
          <div className="intake-field">
            <label className="dialog-label" htmlFor="intake-repro">Steps to reproduce</label>
            <textarea
              id="intake-repro"
              className="form-input dialog-textarea"
              rows={3}
              value={fields.reproSteps}
              onChange={(e) => updateField('reproSteps', e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="intake-field">
            <label className="dialog-label" htmlFor="intake-expected">Expected</label>
            <textarea
              id="intake-expected"
              className="form-input dialog-textarea"
              rows={2}
              value={fields.expected}
              onChange={(e) => updateField('expected', e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="intake-field">
            <label className="dialog-label" htmlFor="intake-actual">Actual</label>
            <textarea
              id="intake-actual"
              className="form-input dialog-textarea"
              rows={2}
              value={fields.actual}
              onChange={(e) => updateField('actual', e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="intake-field">
            <label className="dialog-label" htmlFor="intake-environment">Environment</label>
            <input
              id="intake-environment"
              className="form-input"
              value={fields.environment}
              onChange={(e) => updateField('environment', e.target.value)}
              placeholder="Device, browser/app version, etc."
              disabled={submitting}
            />
          </div>
        </div>
      </details>

      <div className="intake-field">
        <label className="dialog-label" htmlFor="intake-attachments">
          Attachments <span className="dialog-optional">optional</span>
        </label>
        <input
          id="intake-attachments"
          type="file"
          multiple
          ref={fileInputRef}
          disabled={submitting}
        />
        <div className="intake-attachment-hint">PNG, JPEG, WebP, TXT, or LOG — up to 5 MB each.</div>
      </div>

      {formError && <div className="dialog-error" role="alert">{formError}</div>}

      <button type="submit" className="form-button-primary" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Submit'}
      </button>
    </form>
  );
}

function describeSubmitError(err: unknown): string {
  const status = apiErrorStatus(err);
  if (status === 429) {
    const retryAfter = apiErrorRetryAfterSeconds(err);
    return retryAfter
      ? `Please wait ${retryAfter}s before submitting again.`
      : 'Please wait a moment before submitting again.';
  }
  if (status === 401) return 'Your session expired — please log in again.';
  return 'Could not submit — please try again.';
}

function describeUploadError(err: unknown): string {
  const status = apiErrorStatus(err);
  if (status === 413) return 'file too large';
  if (status === 415) return 'unsupported file type';
  if (status === 409) return 'too many/too large attachments';
  if (status === 429) return 'please wait and try again';
  return 'upload failed';
}
