import type { Pool } from "pg";
import { ServiceError } from "./http";

// Signing in to Google's APIs for one account, the way an installed app does: a refresh token,
// made once with the account's consent, buys a short-lived access token. The token is kept
// until a minute before it runs out, then bought again.

export type GoogleAccount = { clientId: string; clientSecret: string; refreshToken: string };

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me/";
export const DRIVE_API = "https://www.googleapis.com/drive/v3/";

export function googleAccessToken(account: GoogleAccount, tokenUrl = GOOGLE_TOKEN_URL): () => Promise<string> {
  let held: { token: string; until: number } | null = null;
  return async () => {
    if (held && held.until > Date.now()) return held.token;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: account.clientId,
        client_secret: account.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const answer = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
    if (!response.ok || !answer.access_token) {
      throw new ServiceError("Google sign-in", response.status, answer.error_description ?? answer.error ?? "Google gave no access token.");
    }
    held = { token: answer.access_token, until: Date.now() + ((answer.expires_in ?? 3600) - 60) * 1000 };
    return held.token;
  };
}

// A JSON call to one Google API. A failure keeps Google's own sentence; the token never appears.
export function googleClient(service: string, baseUrl: string, accessToken: () => Promise<string>) {
  async function call(route: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await accessToken()}`);
    if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(new URL(route, baseUrl), { ...init, headers, signal: AbortSignal.timeout(30_000) });
  }

  async function failure(response: Response): Promise<ServiceError> {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    return new ServiceError(service, response.status, body.error?.message ?? response.statusText);
  }

  return {
    call,
    failure,
    async json<T>(route: string, init: RequestInit = {}): Promise<T> {
      const response = await call(route, init);
      if (!response.ok) throw await failure(response);
      return (await response.json()) as T;
    },
  };
}

// Where the first read starts: the cursor the first watch on this source returned.
export async function startCursor(pool: Pool, source: string, service: string): Promise<string> {
  const { rows } = await pool.query<{ start_cursor: string | null }>("SELECT start_cursor FROM subscriptions WHERE source = $1", [source]);
  const cursor = rows[0]?.start_cursor;
  if (!cursor) throw new ServiceError(service, 409, "There is no watch yet, so there is nowhere to start reading. Start the gateway once.");
  return cursor;
}
