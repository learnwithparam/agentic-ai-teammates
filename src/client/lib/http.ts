import { z } from "zod";

// How every page talks to its own server. Each app mounts sign-in at its own path, so the page
// says where. A missing session sends the person to sign in and back to the same screen.

// The server's own words for a refusal, such as "This amount is above what you can approve."
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// The words a person sees for any failed call: the server's own sentence, or one plain line of our own.
export function problemText(error: unknown, otherwise = "That did not work. Try again.") {
  return error instanceof ApiError ? error.message : otherwise;
}

export function createHttp(authPath: string) {
  function signIn() {
    const back = window.location.pathname + window.location.search;
    window.location.assign(`${authPath}/login?returnTo=${encodeURIComponent(back)}`);
  }

  async function send(path: string, init?: RequestInit & { contentType?: string }): Promise<unknown> {
    const contentType = init?.contentType ?? (init?.body ? "application/json" : null);
    const response = await fetch(path, {
      ...init,
      headers: { accept: "application/json", ...(contentType ? { "content-type": contentType } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 401) {
      signIn();
      throw new ApiError("Signing you in again.", 401);
    }
    const body = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
    if (!response.ok) throw new ApiError(body?.error ?? `The server answered ${response.status}.`, response.status);
    return body;
  }

  // An answer in a shape the page does not expect is logged for the developer. The person sees a
  // plain sentence, never the parser's report.
  async function get<T>(path: string, shape: z.ZodType<T>): Promise<T> {
    const answer = shape.safeParse(await send(path));
    if (answer.success) return answer.data;
    console.error(`${path} answered in an unexpected shape`, answer.error.issues);
    throw new ApiError("This page got an answer it cannot read. Reload the page, and if it stays, tell your admin.", 200);
  }

  function post(path: string, body: unknown, method = "POST") {
    return send(path, { method, body: JSON.stringify(body) });
  }

  // Sends a file's bytes as they are, for an upload.
  function upload(path: string, file: File) {
    return send(path, { method: "POST", body: file, contentType: file.type || "application/octet-stream" });
  }

  // Ends this session, then Keycloak's, so the next visit asks for a password again.
  async function signOut() {
    const { redirect } = z.object({ redirect: z.string() }).parse(await send(`${authPath}/logout`, { method: "POST" }));
    window.location.assign(redirect);
  }

  return { get, post, upload, signOut };
}
