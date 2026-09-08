import type { OverlayState } from "./types.js";

export type OverlayAction = "hold" | "play" | "loop" | "switch";

export function decideOverlayAction(input: {
  hold: boolean;
  hasCurrent: boolean;
  hasNext: boolean;
  event: "init" | "ended" | "hold" | "release";
}): OverlayAction {
  if (input.hold || !input.hasCurrent) return "hold";
  if (input.event === "ended") {
    return input.hasNext ? "switch" : "loop";
  }
  return "play";
}

export function nextOverlayAfterSwitch(state: OverlayState): OverlayState {
  if (!state.next) return state;
  return {
    ...state,
    current: state.next,
    next: null,
    waitingForFirstScene: false,
  };
}

export function shouldPreload(state: OverlayState): boolean {
  return !state.hold && Boolean(state.current) && Boolean(state.next);
}
