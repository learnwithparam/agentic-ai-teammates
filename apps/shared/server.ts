import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import { ZodError } from "zod";

// The shell every world app and Mission Control share: a health check, JSON bodies, the built
// web page, and an error handler that logs the detail and shows people only a plain sentence.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(name: string): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.get("/healthz", (_request, response) => {
    response.json({ ok: true, service: name });
  });
  return app;
}

// Serves the app's page from the Vite build. Run npm run build once before starting the apps.
export function servePage(app: Express, page: string) {
  const folder = path.join(root, "dist/client", page);
  const index = path.join(folder, "index.html");
  app.use(express.static(folder, { index: false }));
  app.use("/assets", express.static(path.join(root, "dist/client/assets"), { immutable: true, maxAge: "1y" }));
  app.get(/^\/(?!api\/|auth\/|hooks\/).*/, (_request, response) => {
    if (!existsSync(index)) {
      response.status(503).send("The web page is not built yet. Run npm run build.");
      return;
    }
    response.sendFile(index);
  });
}

export const handleErrors: ErrorRequestHandler = (error, request, response, _next) => {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    response.status(400).json({ error: `${issue.path.join(".") || "The request"}: ${issue.message}` });
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  // The detail goes to the log for the operator; the person sees no stack trace or internals.
  console.error(`${request.method} ${request.path}:`, error);
  response.status(500).json({ error: "Something went wrong on our side. Try again in a moment." });
};

// Every process listens on this machine only. On a server, Caddy is the one door in.
export const LOOPBACK = "127.0.0.1";

export function listen(app: Express, name: string, port: number) {
  app.use(handleErrors);
  const server = app.listen(port, LOOPBACK, () => console.log(`${name} listening on http://localhost:${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}
