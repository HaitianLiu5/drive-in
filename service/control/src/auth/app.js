import { Hono } from "hono";
import { errorBody, toYoloError } from "@useyolo/core";
import { consentPage, homePage, loginPage, messagePage } from "./pages.js";
import {
  authenticationOptions,
  registrationOptions,
  setupState,
  verifyAuthentication,
  verifyRegistration,
} from "./passkeys.js";
import { createSession, destroySession, getSession } from "./session.js";

// Unprotected routes: home, owner sign-in, and the OAuth authorization page.
// OAuthProvider owns /oauth/token, /oauth/register and the metadata documents;
// /oauth/authorize is ours because sign-in and consent are app-specific.

export const AUTHORIZE_PATH = "/oauth/authorize";

// Duck-typed so this module stays importable outside workerd (the provider
// package imports cloudflare:workers).
const isAuthorizationError = (error) => error?.name === "AuthorizationError" || error?.constructor?.name === "CimdFetchError";

function authorizationFailure(error) {
  if (error?.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (isAuthorizationError(error)) {
    return messagePage("Cannot connect", error.description || "This app could not be verified. Start again from the app.");
  }
  throw error;
}

export function createAuthApp() {
  const app = new Hono();
  const kv = (c) => c.env.OAUTH_KV;
  const db = (c) => c.env.DB;

  app.onError((error, c) => {
    const yolo = toYoloError(error);
    if (yolo.code === "internal") console.error("auth request failed", error);
    return c.json(errorBody(yolo), yolo.status);
  });

  app.get("/", async (c) => {
    const session = await getSession(kv(c), c.req.raw);
    const origin = new URL(c.env.PUBLIC_ORIGIN || c.req.url).origin;
    return c.html(homePage({ signedIn: Boolean(session), origin }));
  });

  app.get("/login", async (c) => c.html(loginPage(await setupState(db(c)))));

  app.post("/auth/passkey/register/options", async (c) => {
    const { initCode } = await c.req.json().catch(() => ({}));
    const session = await getSession(kv(c), c.req.raw);
    const { options, setCookie } = await registrationOptions({
      env: c.env, db: db(c), kv: kv(c), request: c.req.raw, initCode, session,
    });
    c.header("set-cookie", setCookie);
    return c.json(options);
  });

  app.post("/auth/passkey/register/verify", async (c) => {
    const { response, name } = await c.req.json().catch(() => ({}));
    const { userId } = await verifyRegistration({ env: c.env, db: db(c), kv: kv(c), request: c.req.raw, response, name });
    c.header("set-cookie", await createSession(kv(c), userId));
    return c.json({ ok: true });
  });

  app.post("/auth/passkey/login/options", async (c) => {
    const { options, setCookie } = await authenticationOptions({ env: c.env, kv: kv(c), request: c.req.raw });
    c.header("set-cookie", setCookie);
    return c.json(options);
  });

  app.post("/auth/passkey/login/verify", async (c) => {
    const { response } = await c.req.json().catch(() => ({}));
    const { userId } = await verifyAuthentication({ env: c.env, db: db(c), kv: kv(c), request: c.req.raw, response });
    c.header("set-cookie", await createSession(kv(c), userId));
    return c.json({ ok: true });
  });

  app.post("/auth/logout", async (c) => {
    c.header("set-cookie", await destroySession(kv(c), c.req.raw));
    return c.redirect("/", 303);
  });

  // --- OAuth authorization (yolo-v1.md §3) ----------------------------------
  // Sign in first, then show consent with read / control / manage checked.

  app.get(AUTHORIZE_PATH, async (c) => {
    const session = await getSession(kv(c), c.req.raw);
    if (!session) {
      const url = new URL(c.req.url);
      return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    const oauth = c.env.OAUTH_PROVIDER;
    try {
      const request = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set("content-type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    } catch (error) {
      return authorizationFailure(error);
    }
  });

  app.post(AUTHORIZE_PATH, async (c) => {
    const session = await getSession(kv(c), c.req.raw);
    if (!session) return messagePage("Signed out", "Sign in again, then retry from the app.", 401);
    const oauth = c.env.OAUTH_PROVIDER;
    try {
      const form = await c.req.raw.formData();
      const handle = String(form.get("handle") || "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const scope = form.getAll("scope").map(String);
      if (!scope.length) return messagePage("Nothing allowed", "Tick at least one permission, or choose Deny.");
      const approved = await oauth.approveConsent(c.req.raw, handle, { scope });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: session.userId,
        metadata: {},
        scope: approved.request.scope,
        props: { userId: session.userId },
      });
      approved.headers.set("location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      return authorizationFailure(error);
    }
  });

  return app;
}
