import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { startActiveObservation } from "@langfuse/tracing";
import { startTracing } from "./tracing";

// A port that was free a moment ago, so nothing answers on it.
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("a Langfuse that cannot be reached loses the traces and never stops the process", async () => {
  const baseUrl = `http://127.0.0.1:${await closedPort()}`;
  const stop = startTracing("tracing-test", { baseUrl, publicKey: "pk-lf-test", secretKey: "sk-lf-test" });
  await startActiveObservation("a span with nowhere to go", async () => {});
  await assert.doesNotReject(stop());
});
