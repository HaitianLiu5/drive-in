// Error codes shared by the HTTP API, MCP tools, and the node's internal API
// (yolo-v1.md §5). Every failure crosses a boundary as
// { error: { code, message, retryable } }.

export const ERROR_STATUS = Object.freeze({
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  device_offline: 409,
  node_offline: 503,
  resolve_failed: 502,
  superseded: 409,
  rate_limited: 429,
  internal: 500,
});

const RETRYABLE = new Set(["device_offline", "node_offline", "resolve_failed", "rate_limited"]);

export class YoloError extends Error {
  constructor(code, message, { retryable, cause } = {}) {
    super(message, { cause });
    this.name = "YoloError";
    this.code = ERROR_STATUS[code] ? code : "internal";
    this.retryable = retryable ?? RETRYABLE.has(this.code);
  }

  get status() {
    return ERROR_STATUS[this.code];
  }
}

export function toYoloError(error) {
  if (error instanceof YoloError) return error;
  return new YoloError("internal", error?.message || String(error), { cause: error });
}

export function errorBody(error) {
  const { code, message, retryable } = toYoloError(error);
  return { error: { code, message, retryable } };
}

// Rebuild a YoloError from a JSON error body received over HTTP.
export function fromErrorBody(body, fallbackStatus) {
  const error = body?.error;
  if (error && typeof error === "object" && typeof error.code === "string") {
    return new YoloError(error.code, error.message || error.code, { retryable: error.retryable });
  }
  const code = Object.keys(ERROR_STATUS).find((key) => ERROR_STATUS[key] === fallbackStatus) || "internal";
  return new YoloError(code, typeof error === "string" ? error : `Request failed with status ${fallbackStatus}`);
}
