import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { publishDashboardStream, readDashboardStream } from '../../dashboardStream';
import { SCENE } from './officeLook';
import { OfficeLiveBadge } from './officeLive';

const oldSnapshot = '2020-01-01T00:00:00.000Z';

describe('office live badge', () => {
  it('says CONNECTING before the stream has opened once', () => {
    expect(readDashboardStream()).toBe('connecting');
    const html = renderToStaticMarkup(React.createElement(OfficeLiveBadge, {
      failed: false,
      loadedAt: null,
    }));
    expect(html).toContain('CONNECTING');
    expect(html).toContain(SCENE.stale);
  });

  it('shows LIVE when the view mounts after the stream is already open', () => {
    publishDashboardStream(true);
    const html = renderToStaticMarkup(React.createElement(OfficeLiveBadge, {
      failed: false,
      loadedAt: new Date().toISOString(),
    }));
    expect(html).toContain('LIVE');
    expect(html).toContain(SCENE.live);
    expect(html).not.toContain('CONNECTING');
  });

  it('stays LIVE on an open stream when the snapshot is old, and still shows the age', () => {
    publishDashboardStream(true);
    const html = renderToStaticMarkup(React.createElement(OfficeLiveBadge, {
      failed: false,
      loadedAt: oldSnapshot,
    }));
    expect(html).toContain('LIVE');
    expect(html).toContain(SCENE.live);
    expect(html).toContain('Updated');
    expect(html).toContain('ago');
    expect(html).not.toContain('STALE');
  });

  it('says STALE when the stream drops or the fetch fails', () => {
    publishDashboardStream(false);
    const dropped = renderToStaticMarkup(React.createElement(OfficeLiveBadge, {
      failed: false,
      loadedAt: new Date().toISOString(),
    }));
    expect(dropped).toContain('STALE');
    expect(dropped).toContain(SCENE.stale);
    expect(dropped).not.toContain('>LIVE');

    publishDashboardStream(true);
    const failed = renderToStaticMarkup(React.createElement(OfficeLiveBadge, {
      failed: true,
      loadedAt: new Date().toISOString(),
    }));
    expect(failed).toContain('STALE');
    expect(failed).toContain(SCENE.stale);
  });
});
