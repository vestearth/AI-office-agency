// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind, ReviewModelResponse, RunSummary } from '../../../shared/types';
import { ACTION_ORDER } from './actionOrder';
import { CommandView, resetCommandViewCache } from './CommandView';
import { clearReleaseIndexCache } from './ReleaseCard';
import { resetReviewViewCache, ReviewView } from './ReviewView';
import { FlowView } from './FlowView';

const TASK_ID = 'TASK-SPAR-35';

type Call = {
  url: string;
  signal: AbortSignal | null;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

let calls: Call[] = [];
let root: Root | null = null;
let el: HTMLDivElement | null = null;

function callsTo(path: string): Call[] {
  return calls.filter((call) => call.url.split('?')[0] === path);
}

function expectAborted(path: string) {
  const matching = callsTo(path);
  expect(matching.length, path).toBeGreaterThan(0);
  for (const call of matching) {
    expect(call.signal, path).not.toBeNull();
    expect(call.signal?.aborted, path).toBe(true);
  }
}

function reviewBody(): ReviewModelResponse {
  const actionCounts = Object.fromEntries(ACTION_ORDER.map((kind) => [kind, 0])) as Record<ActionKind, number>;
  actionCounts.workflow_exception = 1;
  return {
    generatedAt: '2026-10-23T00:00:00.000Z',
    total: 1,
    needsReviewCount: 0,
    actionCount: 1,
    actionCounts,
    reviews: [{
      taskId: TASK_ID,
      title: 'Keep the queue',
      phase: 'assigned',
      verdict: null,
      inReviewQueue: false,
      verdictNeedsAttention: false,
      needsReview: false,
      requiresAction: true,
      actionKind: 'workflow_exception',
      actionReason: 'blocked',
      recommendedAction: 'Inspect task',
      decisionPending: false,
      statusUpdatedAt: '2026-10-23T00:00:00.000Z',
      lastReviewedAt: null,
      confidence: null,
      issueCounts: { error: 0, warning: 0, suggestion: 0 },
      riskLevel: 'none',
      latestDecision: null,
      idle: null,
      lastTransition: null,
      waitsOn: [],
      isReleaseTrain: false,
    }],
  };
}

function runsBody(): RunSummary[] {
  return [{ id: TASK_ID, title: 'Keep the queue', status: 'running', runPath: `runs/${TASK_ID}` }];
}

function mount(node: React.ReactNode) {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => { root?.render(node); });
}

function unmount() {
  act(() => { root?.unmount(); });
  el?.remove();
  root = null;
  el = null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  calls = [];
  resetCommandViewCache();
  resetReviewViewCache();
  clearReleaseIndexCache();
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('dashboard_token', '');
  vi.stubGlobal('prompt', () => '');
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let resolvePromise!: (value: unknown) => void;
    let rejectPromise!: (error: unknown) => void;
    const done = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const call: Call = {
      url,
      signal: init?.signal ?? null,
      settled: false,
      resolve: (value) => {
        if (call.settled) return;
        call.settled = true;
        resolvePromise(value);
      },
      reject: (error) => {
        if (call.settled) return;
        call.settled = true;
        rejectPromise(error);
      },
    };
    call.signal?.addEventListener('abort', () => {
      call.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
    calls.push(call);
    return done.then((json) => new Response(JSON.stringify(json ?? null), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  });
});

afterEach(() => {
  if (root) unmount();
  vi.unstubAllGlobals();
});

describe('CommandView fetch lifecycle', () => {
  const paths = ['/api/review', '/api/runs', '/api/analytics/flow', '/api/launch/active', '/api/launch/chains'];

  it('aborts command fetches when Operations leaves the screen', () => {
    mount(createElement(CommandView));
    unmount();
    for (const path of paths) expectAborted(path);
  });

  it('aborts the in-flight command fetch when Operations reloads', async () => {
    mount(createElement(CommandView));
    const first = callsTo('/api/review');
    expect(first).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new Event('dashboard:refresh'));
    });
    expect(first[0]?.signal?.aborted).toBe(true);
    const next = callsTo('/api/review');
    expect(next.length).toBeGreaterThan(1);
    expect(next.at(-1)?.signal?.aborted).toBe(false);
    expect(document.body.textContent).toContain('Loading command center');
    expect(document.body.textContent).not.toContain('Failed to load');
    expect(document.body.textContent).not.toContain('No tasks.');
  });

  it('paints the previous Operations queue on re-entry without loading', async () => {
    mount(createElement(CommandView));
    const review = callsTo('/api/review')[0];
    const runs = callsTo('/api/runs')[0];
    const flow = callsTo('/api/analytics/flow')[0];
    expect(review && runs && flow).toBeTruthy();
    await act(async () => {
      review?.resolve(reviewBody());
      runs?.resolve(runsBody());
      flow?.resolve(null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('.queue .row')?.textContent).toContain('SPAR-35');
    unmount();
    mount(createElement(CommandView));
    expect(document.body.textContent).not.toContain('Loading command center');
    expect(document.querySelector('.queue .row')?.textContent).toContain('SPAR-35');
  });
});

describe('ReviewView fetch lifecycle', () => {
  it('aborts the Action Center fetch when Attention leaves the screen', () => {
    mount(createElement(ReviewView));
    unmount();
    expectAborted('/api/review');
    expectAborted('/api/reports/release-ladder');
  });

  it('aborts the in-flight Action Center fetch when Attention reloads', async () => {
    mount(createElement(ReviewView));
    const firstReview = callsTo('/api/review');
    const firstLadder = callsTo('/api/reports/release-ladder');
    expect(firstReview).toHaveLength(1);
    expect(firstLadder).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new Event('dashboard:refresh'));
    });
    expect(firstReview[0]?.signal?.aborted).toBe(true);
    expect(firstLadder[0]?.signal?.aborted).toBe(true);
    expect(callsTo('/api/review').at(-1)?.signal?.aborted).toBe(false);
    expect(document.body.textContent).toContain('Loading Action Center');
    expect(document.body.textContent).not.toContain('Failed to load Action Center');
  });

  it('paints the previous Attention list on re-entry without loading', async () => {
    mount(createElement(ReviewView));
    const review = callsTo('/api/review')[0];
    expect(review).toBeTruthy();
    await act(async () => {
      review?.resolve(reviewBody());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('.action-table tbody tr')?.textContent).toContain(TASK_ID);
    unmount();
    mount(createElement(ReviewView));
    expect(document.body.textContent).not.toContain('Loading Action Center');
    expect(document.querySelector('.action-table tbody tr')?.textContent).toContain(TASK_ID);
  });
});

describe('FlowView fetch lifecycle', () => {
  it('aborts the flow fetch when Insights leaves the screen', () => {
    mount(createElement(FlowView));
    unmount();
    expectAborted('/api/analytics/flow');
  });

  it('aborts the in-flight flow fetch when Insights reloads', async () => {
    mount(createElement(FlowView));
    const first = callsTo('/api/analytics/flow');
    expect(first).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new Event('dashboard:refresh'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(first[0]?.signal?.aborted).toBe(true);
    expect(callsTo('/api/analytics/flow').length).toBeGreaterThan(1);
    expect(callsTo('/api/analytics/flow').at(-1)?.signal?.aborted).toBe(false);
    expect(document.body.textContent).not.toContain('Could not load flow insights');
    await flush();
  });
});
