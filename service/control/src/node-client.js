import { fromErrorBody, signNodeRequest, YoloError } from "@useyolo/core";

// Every control plane → media node call goes through nodeFetch() (decision 17).
//
// NODE_TRANSPORT selects the path; switching is a config change only:
// - "vpc" (default): the Workers VPC service binding `NODE`, which reaches the
//   node through Cloudflare Tunnel. The node has no public hostname.
// - "tunnel": the Tunnel's public hostname NODE_PUBLIC_ORIGIN behind Cloudflare
//   Access, authenticated with a service token.
// Either way the request is signed with NODE_SECRET (yolo-v1.md §8).

const DEFAULT_TIMEOUT_MS = 15_000;
const OFFLINE_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);

export function nodeTransport(env) {
  return env.NODE_TRANSPORT === "tunnel" ? "tunnel" : "vpc";
}

function upstream(env, pathAndQuery) {
  if (nodeTransport(env) === "tunnel") {
    if (!env.NODE_PUBLIC_ORIGIN) throw new YoloError("node_offline", "NODE_PUBLIC_ORIGIN is not configured");
    return {
      url: new URL(pathAndQuery, env.NODE_PUBLIC_ORIGIN),
      fetcher: (url, init) => fetch(url, init),
      headers: {
        "cf-access-client-id": env.NODE_ACCESS_CLIENT_ID || "",
        "cf-access-client-secret": env.NODE_ACCESS_CLIENT_SECRET || "",
      },
    };
  }
  if (!env.NODE?.fetch) throw new YoloError("node_offline", "The NODE Workers VPC binding is not configured");
  return {
    url: new URL(pathAndQuery, env.NODE_ORIGIN || "http://127.0.0.1:9191"),
    fetcher: (url, init) => env.NODE.fetch(url, init),
    headers: {},
  };
}

export async function nodeFetch(env, path, {
  method = "GET",
  query,
  body,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  raw = false,
  signal,
} = {}) {
  if (!env.NODE_SECRET) throw new YoloError("node_offline", "NODE_SECRET is not configured");
  const search = query ? `?${new URLSearchParams(Object.entries(query).filter(([, value]) => value != null))}` : "";
  const pathAndQuery = `${path}${search === "?" ? "" : search}`;
  const payload = body === undefined ? "" : JSON.stringify(body);
  const target = upstream(env, pathAndQuery);
  const signature = await signNodeRequest(env.NODE_SECRET, { method, path: pathAndQuery, body: payload });

  const timeout = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await target.fetcher(target.url, {
      method,
      headers: {
        ...target.headers,
        ...signature,
        ...(payload ? { "content-type": "application/json" } : {}),
        accept: raw ? "*/*" : "application/json",
        ...headers,
      },
      body: payload || undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    const timedOut = timeout.aborted;
    throw new YoloError(
      "node_offline",
      timedOut ? `Media node did not answer within ${Math.round(timeoutMs / 1000)}s` : "Media node is offline",
      { cause: error },
    );
  }

  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  if (!response.ok && !isJson) {
    if (OFFLINE_STATUSES.has(response.status)) throw new YoloError("node_offline", "Media node is offline");
    if (response.status === 401 || response.status === 403) {
      throw new YoloError("node_offline", "Media node rejected the control plane's credentials");
    }
  }
  if (raw && response.ok) return response;
  const data = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) throw fromErrorBody(data, response.status);
  return data;
}

// Thin per-env wrapper so callers and tests can swap the transport.
export function createNodeClient(env) {
  return {
    request: (path, options) => nodeFetch(env, path, options),
    get: (path, query, options = {}) => nodeFetch(env, path, { ...options, query }),
    post: (path, body = {}, options = {}) => nodeFetch(env, path, { ...options, method: "POST", body }),
  };
}
