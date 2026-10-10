// Device capabilities (yolo-v1.md §6). Tesla's canvas player is one profile;
// other renderers send their own in `hello`.

export const RENDERERS = Object.freeze(["canvas-webcodecs", "html5-video", "native", "external"]);
export const DEVICE_KINDS = Object.freeze(["car", "browser", "phone", "tv"]);

export const TESLA_CANVAS_CAPABILITIES = Object.freeze({
  renderer: "canvas-webcodecs",
  delivery: ["hls", "mp4"],
  video: ["avc1"],
  audio: ["mp4a"],
  maxHeight: 720,
  subtitles: "client-vtt",
  audioOnly: false,
});

const SUBTITLE_MODES = new Set(["client-vtt", "native-vtt", "burn-in"]);

function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item) => typeof item === "string" && item.length <= 32).slice(0, 16);
}

export function normalizeCapabilities(input = {}) {
  const value = input && typeof input === "object" ? input : {};
  const maxHeight = Number(value.maxHeight);
  return {
    renderer: RENDERERS.includes(value.renderer) ? value.renderer : "html5-video",
    delivery: stringList(value.delivery, ["hls", "mp4"]),
    video: stringList(value.video, ["avc1"]),
    audio: stringList(value.audio, ["mp4a"]),
    maxHeight: Number.isFinite(maxHeight) && maxHeight > 0 ? Math.min(4320, Math.floor(maxHeight)) : 1080,
    subtitles: SUBTITLE_MODES.has(value.subtitles) ? value.subtitles : "client-vtt",
    audioOnly: value.audioOnly === true,
  };
}
