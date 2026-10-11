import { isClaimed } from "@useyolo/core";

const CLAIM_TIMEOUT_MS = 10_000;

// A URL becomes a Source when a source plugin on the node claims it
// (decision 21, docs/yolo-plugins.md). The node asks its plugins in order
// and the first claim wins. A Source passes through unchanged.
export async function claimSource(node, source) {
  if (isClaimed(source)) return source;
  const { source: claimed } = await node.post("/internal/v1/claim", { url: source.url }, { timeoutMs: CLAIM_TIMEOUT_MS });
  return claimed;
}
