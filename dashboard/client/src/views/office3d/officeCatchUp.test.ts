import { describe, expect, it } from 'vitest';
import { initialCatchUp, onFrame, onReloadSettled, onStreamPhase } from './officeCatchUp';

describe('stream catch-up', () => {
  it('snaps a transition that arrives after the stream reconnects', () => {
    let state = initialCatchUp(false);
    state = onStreamPhase(state, true).state;
    let frame = onFrame(state, true, true);
    expect(frame.snap).toBe(false);

    state = onStreamPhase(frame.state, false).state;
    const reconnect = onStreamPhase(state, true);
    expect(reconnect.reload).toBe(true);
    state = reconnect.state;

    frame = onFrame(state, true, true);
    expect(frame.snap).toBe(true);

    state = onReloadSettled(frame.state);
    frame = onFrame(state, true, true);
    expect(frame.snap).toBe(true);

    frame = onFrame(frame.state, true, true);
    expect(frame.snap).toBe(false);
  });

  it('does not reload or snap the first time the stream opens', () => {
    const opened = onStreamPhase(initialCatchUp(false), true);
    expect(opened.reload).toBe(false);
    expect(onFrame(opened.state, true, true).snap).toBe(false);
  });
});
