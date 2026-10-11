// Realtime heartbeat (yolo-v1.md §7). The device sends HEARTBEAT_PING as this
// exact string and the Hub answers HEARTBEAT_PONG without waking up, through
// the Durable Object WebSocket auto-response. Any other spelling of a ping
// wakes the Hub and is rejected as an unknown message.

export const HEARTBEAT_PING = '{"v":1,"type":"ping"}';
export const HEARTBEAT_PONG = '{"v":1,"type":"pong"}';
// Cloudflare closes a WebSocket after 100 seconds without traffic.
export const HEARTBEAT_INTERVAL_MS = 25_000;

// Fixed-window counter: the returned function records one event and reports
// whether it is still within `max` events for the current window.
export function createRateLimit({ max, windowMs }, now = Date.now) {
  let windowStart = -Infinity;
  let count = 0;
  return () => {
    const time = now();
    if (time - windowStart >= windowMs) {
      windowStart = time;
      count = 0;
    }
    count += 1;
    return count <= max;
  };
}
