export interface CatchUpState {
  armed: boolean;
  awaitingReload: boolean;
  sawOpen: boolean;
  closedAfterOpen: boolean;
}

export function initialCatchUp(streamOpen: boolean): CatchUpState {
  return { armed: false, awaitingReload: false, sawOpen: streamOpen, closedAfterOpen: false };
}

/**
 * Closing the stream after it has been open arms the latch.
 * Opening again after that close reloads immediately and holds the latch
 * until that payload is applied.
 */
export function onStreamPhase(state: CatchUpState, open: boolean): { state: CatchUpState; reload: boolean } {
  if (open) {
    const reload = state.sawOpen && state.closedAfterOpen;
    return {
      reload,
      state: {
        armed: state.armed || reload,
        awaitingReload: reload || state.awaitingReload,
        sawOpen: true,
        closedAfterOpen: false,
      },
    };
  }
  return {
    reload: false,
    state: {
      ...state,
      armed: state.armed || state.sawOpen,
      closedAfterOpen: state.sawOpen || state.closedAfterOpen,
    },
  };
}

/** Snap while armed or while the reconnect payload is still in flight. Clear only after that payload can be applied. */
export function onFrame(state: CatchUpState, animate: boolean, streamOpen: boolean): { snap: boolean; state: CatchUpState } {
  const armed = state.armed || !animate;
  const snap = armed || state.awaitingReload;
  const clear = animate && streamOpen && !state.awaitingReload;
  return { snap, state: { ...state, armed: clear ? false : armed } };
}

export function onReloadSettled(state: CatchUpState): CatchUpState {
  return { ...state, awaitingReload: false };
}
