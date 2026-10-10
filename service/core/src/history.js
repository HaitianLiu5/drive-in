// History keeps only the most recent entries (decision 13).
export const HISTORY_LIMIT = 500;

// Treat a source as finished near the end so "continue watching" skips it.
export function isFinished(position, duration) {
  const total = Number(duration) || 0;
  return total > 0 && Number(position) >= total - Math.min(60, total * 0.05);
}
