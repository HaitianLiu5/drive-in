import { errorBody, toYoloError } from "@useyolo/core";
import { nodeFetch } from "./node-client.js";

// /m/{token}/… is passed through to the node unchanged (decision 9). The
// token in the path is the credential; the node verifies it locally.
const FORWARDED_HEADERS = ["range", "if-none-match", "if-modified-since", "accept"];

export async function proxyMedia(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const headers = {};
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  try {
    const upstream = await nodeFetch(env, url.pathname + url.search, {
      method: request.method, headers, raw: true, timeoutMs: 30_000, signal: request.signal,
    });
    return new Response(upstream.body, upstream);
  } catch (error) {
    const yolo = toYoloError(error);
    return Response.json(errorBody(yolo), { status: yolo.status });
  }
}
