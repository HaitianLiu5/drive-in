// PlaybackState is the single playback snapshot the Hub broadcasts
// (yolo-v1.md §4). Clients extrapolate progress from position + positionAt.

export const PLAYBACK_STATUSES = Object.freeze(["idle", "loading", "playing", "paused", "buffering"]);
export const CONTROL_ACTIONS = Object.freeze(["pause", "resume", "stop", "next", "previous"]);
export const LOAD_REASONS = Object.freeze(["play", "recovery", "seek", "quality", "transfer", "tracks"]);

export function emptyPlaybackState() {
  return {
    status: "idle",
    deviceId: null,
    item: null,
    position: 0,
    positionAt: 0,
    tracks: { subtitles: [], audio: null },
    sessionId: null,
  };
}

export function currentPosition(state, now = Date.now()) {
  const position = Number(state?.position) || 0;
  if (state?.status !== "playing" || !state.positionAt) return position;
  const elapsed = Math.max(0, now - state.positionAt) / 1000;
  const duration = Number(state.item?.duration) || 0;
  const next = position + elapsed;
  return duration > 0 && !state.item?.isLive ? Math.min(duration, next) : next;
}
