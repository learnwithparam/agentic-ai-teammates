import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Programs reach a world app with an API key, never a person's session. Each key belongs to one
// client and carries only the scopes that client needs: Mission Control can read LDrive, and
// only the upload script can write to it. Keys are compared by their hashes, in constant time.

export type ApiClient = { name: string; scopes: readonly string[]; key: string };

declare module "express-serve-static-core" {
  interface Request {
    client?: { name: string; scopes: readonly string[] };
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function apiKeys(clients: readonly ApiClient[]) {
  const known = clients.map((client) => ({ name: client.name, scopes: client.scopes, hash: digest(client.key) }));
  return function requireScope(scope: string) {
    return (request: Request, response: Response, next: NextFunction) => {
      const header = request.headers.authorization ?? "";
      const presented = digest(header.startsWith("Bearer ") ? header.slice(7) : "");
      const client = known.find((entry) => timingSafeEqual(entry.hash, presented));
      if (!client) {
        response.status(401).json({ error: "A valid API key is needed." });
        return;
      }
      if (!client.scopes.includes(scope)) {
        response.status(403).json({ error: `This key does not have the ${scope} scope.` });
        return;
      }
      request.client = { name: client.name, scopes: client.scopes };
      next();
    };
  };
}
