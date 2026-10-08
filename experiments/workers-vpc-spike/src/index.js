// Workers VPC spike. Proxies every request to the home Drive-In server, either
// through a VPC Service binding (default) or through the existing public tunnel
// hostname (`?__via=public`), so both paths can be compared from one client.

const COOKIE_NAME = "yolo_spike";
const VIA_PARAM = "__via";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__spike/login") return login(url, env);
    if (!(await isAuthorized(request, env))) {
      return new Response("Unauthorized\n", { status: 401 });
    }
    if (url.pathname === "/__spike/health") return health(env);

    const via = url.searchParams.get(VIA_PARAM) === "public" ? "public" : "vpc";
    url.searchParams.delete(VIA_PARAM);
    return proxy(request, url, via, env);
  },
};

async function proxy(request, url, via, env) {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  // The server accepts a WebSocket only when Origin matches Host or
  // X-Forwarded-Host, so present the Worker's own host.
  headers.set("x-forwarded-host", url.host);

  const init = {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  };

  const started = Date.now();
  let upstream;
  try {
    upstream = await upstreamFetch(env, via, url.pathname + url.search, init);
  } catch (err) {
    return new Response(`Upstream ${via} failed: ${err?.message || err}\n`, {
      status: 502,
      headers: { "x-spike-via": via },
    });
  }
  const ttfbMs = Date.now() - started;

  if (upstream.status === 101) return upstream;

  const response = new Response(upstream.body, upstream);
  response.headers.append("server-timing", `upstream;desc="${via}";dur=${ttfbMs}`);
  response.headers.set("x-spike-via", via);
  return response;
}

function upstreamFetch(env, via, pathAndQuery, init) {
  if (via === "public") return fetch(new URL(pathAndQuery, env.PUBLIC_ORIGIN), init);
  return env.NODE.fetch(new URL(pathAndQuery, env.NODE_ORIGIN), init);
}

async function health(env) {
  const probe = async (via) => {
    const started = Date.now();
    try {
      const res = await upstreamFetch(env, via, "/api/health", { headers: { accept: "application/json" } });
      const body = await res.text();
      return { ok: res.ok, status: res.status, ms: Date.now() - started, body: body.slice(0, 500) };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, error: err?.message || String(err) };
    }
  };
  const [vpc, pub] = await Promise.all([probe("vpc"), probe("public")]);
  return Response.json({ vpc, public: pub });
}

async function login(url, env) {
  const token = url.searchParams.get("token") || "";
  if (!(await tokenMatches(token, env))) return new Response("Unauthorized\n", { status: 401 });
  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "set-cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    },
  });
}

async function isAuthorized(request, env) {
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer && (await tokenMatches(bearer, env))) return true;
  const cookie = readCookie(request.headers.get("cookie"), COOKIE_NAME);
  return Boolean(cookie) && (await tokenMatches(cookie, env));
}

async function tokenMatches(candidate, env) {
  if (!env.SPIKE_TOKEN || !candidate) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.SPIKE_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
