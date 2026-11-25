// A JSON call to a world app with its API key. A failure names the app and its status and
// keeps the app's own sentence; the key never appears in an error.

export class ServiceError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    // What the service said, without who said it or the status. A person can read this one.
    readonly detail: string,
  ) {
    super(`${service} answered ${status}: ${detail}`);
  }
}

export function serviceClient(service: string, baseUrl: string, apiKey: string) {
  async function call(route: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(new URL(route, baseUrl), {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
    return response;
  }

  async function failure(response: Response): Promise<ServiceError> {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return new ServiceError(service, response.status, body.error ?? response.statusText);
  }

  return {
    call,
    failure,
    async json<T>(route: string, init: RequestInit = {}): Promise<T> {
      const response = await call(route, init);
      if (!response.ok) throw await failure(response);
      return (await response.json()) as T;
    },
    async bytes(route: string): Promise<{ contentType: string; bytes: Uint8Array }> {
      const response = await call(route);
      if (!response.ok) throw await failure(response);
      return { contentType: response.headers.get("Content-Type") ?? "application/octet-stream", bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}
