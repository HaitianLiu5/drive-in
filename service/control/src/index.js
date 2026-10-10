import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createV1App } from "./api/v1.js";
import { AUTHORIZE_PATH, createAuthApp } from "./auth/app.js";
import { hubClient } from "./hub/hub.js";
import { handleMcpRequest } from "./mcp/handler.js";
import { proxyMedia } from "./media.js";
import { createNodeClient } from "./node-client.js";
import { handleRealtime, issueRealtimeTicket } from "./realtime.js";
import { createServices } from "./services.js";

export { Hub } from "./hub/hub.js";

// Yolo control plane (yolo-v1.md §2). One Worker serves:
//   /mcp            remote MCP (Streamable HTTP), OAuth-protected
//   /v1/*           HTTP API, OAuth-protected
//   /v1/realtime    WebSocket to the user's Hub Durable Object (ticket auth)
//   /m/*            media passthrough to the node (signed path token)
//   /oauth/*        OAuth 2.1 authorization server, plus owner sign-in pages

export const SCOPES = ["read", "control", "manage"];

function buildServices(env, userId) {
  return createServices({ db: env.DB, userId, hub: hubClient(env, userId), node: createNodeClient(env) });
}

const mcpApi = {
  fetch(request, env, ctx) {
    const origin = new URL(env.PUBLIC_ORIGIN || request.url);
    return handleMcpRequest(request, {
      services: buildServices(env, ctx.props.userId),
      scopes: ctx.auth?.scope ?? [],
      allowedHostnames: [origin.hostname],
    });
  },
};

const v1App = createV1App({
  getContext: (c) => ({
    services: buildServices(c.env, c.executionCtx.props.userId),
    scopes: c.executionCtx.auth?.scope ?? [],
    userId: c.executionCtx.props.userId,
  }),
  issueRealtimeTicket,
});

const authApp = createAuthApp();

// The token audience is the deployment's origin, which covers /mcp and /v1.
// It comes from PUBLIC_ORIGIN, so the provider is built on first request.
let provider = null;
let providerOrigin = null;

function oauthProvider(env, request) {
  const origin = new URL(env.PUBLIC_ORIGIN || request.url).origin;
  if (provider && providerOrigin === origin) return provider;
  providerOrigin = origin;
  provider = new OAuthProvider({
    apiHandlers: {
      "/mcp": mcpApi,
      "/v1/": { fetch: (req, e, ctx) => v1App.fetch(req, e, ctx) },
    },
    defaultHandler: { fetch: (req, e, ctx) => authApp.fetch(req, e, ctx) },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: SCOPES,
    // Agents ask for every scope by default; the consent page can drop some.
    requiredScopes: SCOPES,
    accessTokenTTL: 60 * 60,
    resourceMetadata: { resource: origin, authorization_servers: [origin], resource_name: "Yolo" },
  });
  return provider;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/realtime") return handleRealtime(request, env);
    if (pathname.startsWith("/m/")) return proxyMedia(request, env);
    return oauthProvider(env, request).fetch(request, env, ctx);
  },
};
