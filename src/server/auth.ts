import { randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { createRemoteJWKSet, type JWTPayload, jwtVerify, type JWTVerifyGetKey } from "jose";
import * as oidc from "openid-client";
import type { Pool } from "pg";
import { ROLES, type Role } from "./people";

// Sign-in through Keycloak for Mission Control and the three world apps. The browser holds only
// an opaque session id in an httpOnly cookie; the tokens stay in Postgres. Each request checks
// the access token's signature, issuer and audience, and refreshes it shortly before it ends.

export type Person = {
  subject: string;
  email: string;
  name: string;
  company: string;
  roles: Role[];
  // In the company's currency. Only approvers have one.
  approvalLimit?: number;
};

export type AuthSettings = {
  pool: Pool;
  issuer: string;
  clientId: string;
  clientSecret: string;
  // The address people open, such as http://localhost:3333.
  appUrl: string;
  // Where the sign-in routes are mounted, such as /api/auth.
  mountPath: string;
  // Every app on localhost shares cookies across ports, so each app names its own cookie.
  cookieName: string;
  // The audience access tokens must carry. Only Mission Control's API asks for one.
  audience?: string;
  // Runs after each sign-in, with the person the token names.
  onSignIn?: (person: Person) => Promise<void>;
};

type StoredTokens = { access_token: string; refresh_token?: string; id_token?: string; expires_at: number };

const SESSION_HOURS = 8;
const REFRESH_EARLY_SECONDS = 30;

// The token claims a person is made of. A token without a company is refused: everyone belongs
// to exactly one Keycloak organization.
export function personFromClaims(claims: JWTPayload): Person {
  const organizations = claims.organization;
  const company = Array.isArray(organizations) ? organizations[0] : undefined;
  if (typeof company !== "string") throw new Error("This account is not in a company. Ask an admin to add it to one.");
  const access = claims.realm_access as { roles?: unknown } | undefined;
  const held = Array.isArray(access?.roles) ? access.roles : [];
  const roles = ROLES.filter((role) => held.includes(role));
  const limit = Number(claims.approval_limit);
  const name = typeof claims.name === "string" ? claims.name : String(claims.preferred_username ?? "");
  return {
    subject: String(claims.sub),
    email: String(claims.email ?? ""),
    name,
    company,
    roles,
    approvalLimit: roles.includes("approver") && Number.isFinite(limit) ? limit : undefined,
  };
}

export async function verifyAccessToken(token: string, keys: JWTVerifyGetKey, issuer: string, audience?: string): Promise<Person> {
  const { payload } = await jwtVerify(token, keys, { issuer, audience, clockTolerance: 5 });
  return personFromClaims(payload);
}

// Reads one cookie from the request. Cookie values here are ids we made, so no decoding is needed.
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

// Where to go after signing in: a path on this app only, never another site. A browser reads
// "/\\evil.example" as another site, so the path is resolved and its origin compared.
export function samePagePath(asked: unknown, appUrl: string): string {
  if (typeof asked !== "string" || !asked.startsWith("/")) return "/";
  if (/[\\\u0000-\u001f]/.test(asked)) return "/";
  const resolved = new URL(asked, appUrl);
  if (resolved.origin !== new URL(appUrl).origin) return "/";
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

declare module "express-serve-static-core" {
  interface Request {
    person?: Person;
  }
}

export async function createAuth(settings: AuthSettings) {
  const { pool, cookieName } = settings;
  const issuerUrl = new URL(settings.issuer);
  // Plain HTTP is only for Keycloak on this machine; in production the issuer is https.
  const options = issuerUrl.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined;
  const config = await oidc.discovery(issuerUrl, settings.clientId, settings.clientSecret, undefined, options);
  const keys = createRemoteJWKSet(new URL(config.serverMetadata().jwks_uri!));
  const redirectUri = `${settings.appUrl}${settings.mountPath}/callback`;
  const secure = settings.appUrl.startsWith("https:");

  function setCookie(response: Response, value: string, maxAgeSeconds: number) {
    const flags = [`${cookieName}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
    if (secure) flags.push("Secure");
    response.append("Set-Cookie", flags.join("; "));
  }

  async function saveTokens(sessionId: string, tokens: oidc.TokenEndpointResponse) {
    const stored: StoredTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      expires_at: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 300),
    };
    await pool.query("UPDATE sessions SET tokens = $2 WHERE id = $1", [sessionId, stored]);
    return stored;
  }

  // The session's current access token, refreshed when it is about to run out.
  async function currentToken(sessionId: string): Promise<string | null> {
    const { rows } = await pool.query<{ tokens: StoredTokens }>("SELECT tokens FROM sessions WHERE id = $1 AND expires_at > now()", [sessionId]);
    if (!rows[0]) return null;
    const tokens = rows[0].tokens;
    if (tokens.expires_at - REFRESH_EARLY_SECONDS > Date.now() / 1000) return tokens.access_token;
    if (!tokens.refresh_token) return null;
    try {
      const fresh = await oidc.refreshTokenGrant(config, tokens.refresh_token);
      return (await saveTokens(sessionId, fresh)).access_token;
    } catch {
      // Keycloak refused: the account was disabled or the session ended there. Sign out here too.
      await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
      return null;
    }
  }

  const router = express.Router();

  router.get("/login", async (request, response) => {
    const returnTo = samePagePath(request.query.returnTo, settings.appUrl);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    await pool.query("DELETE FROM sign_ins WHERE created_at < now() - interval '10 minutes'");
    await pool.query("INSERT INTO sign_ins (state, code_verifier, nonce, return_to) VALUES ($1, $2, $3, $4)", [state, codeVerifier, nonce, returnTo]);
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid email profile organization",
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    response.redirect(url.href);
  });

  router.get("/callback", async (request, response) => {
    const state = String(request.query.state ?? "");
    const { rows } = await pool.query<{ code_verifier: string; nonce: string; return_to: string }>(
      "DELETE FROM sign_ins WHERE state = $1 AND created_at > now() - interval '10 minutes' RETURNING code_verifier, nonce, return_to",
      [state],
    );
    if (!rows[0]) {
      response.status(400).send("This sign-in link has run out. Start again from the app.");
      return;
    }
    const callbackUrl = new URL(request.originalUrl, settings.appUrl);
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: rows[0].code_verifier,
      expectedState: state,
      expectedNonce: rows[0].nonce,
    });
    const person = await verifyAccessToken(tokens.access_token, keys, settings.issuer, settings.audience);
    await settings.onSignIn?.(person);
    const sessionId = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO sessions (id, subject, tokens, expires_at) VALUES ($1, $2, '{}', now() + make_interval(hours => ${SESSION_HOURS}))`,
      [sessionId, person.subject],
    );
    await saveTokens(sessionId, tokens);
    setCookie(response, sessionId, SESSION_HOURS * 3600);
    response.redirect(rows[0].return_to);
  });

  router.post("/logout", async (request, response) => {
    const sessionId = readCookie(request.headers.cookie, cookieName);
    let idToken: string | undefined;
    if (sessionId) {
      const { rows } = await pool.query<{ tokens: StoredTokens }>("DELETE FROM sessions WHERE id = $1 RETURNING tokens", [sessionId]);
      idToken = rows[0]?.tokens.id_token;
    }
    setCookie(response, "", 0);
    const end = oidc.buildEndSessionUrl(config, { post_logout_redirect_uri: `${settings.appUrl}/`, ...(idToken ? { id_token_hint: idToken } : {}) });
    response.json({ redirect: end.href });
  });

  // Every route after this needs a signed-in person. An API call gets 401; a page goes to sign-in.
  async function requirePerson(request: Request, response: Response, next: NextFunction) {
    const sessionId = readCookie(request.headers.cookie, cookieName);
    const token = sessionId ? await currentToken(sessionId) : null;
    if (token) {
      try {
        request.person = await verifyAccessToken(token, keys, settings.issuer, settings.audience);
        next();
        return;
      } catch {
        // A token that fails its checks ends the session, the same as no token.
      }
    }
    if (request.accepts(["html", "json"]) === "html" && request.method === "GET") {
      response.redirect(`${settings.mountPath}/login?returnTo=${encodeURIComponent(request.originalUrl)}`);
      return;
    }
    response.status(401).json({ error: "Sign in first." });
  }

  return { router, requirePerson };
}
