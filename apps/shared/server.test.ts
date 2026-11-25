import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "./server";

async function get(ready: Parameters<typeof createApp>[1], path: string) {
  const app = createApp("probe", ready);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

test("readyz answers 503 and names the part that is down, without its error", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const result = await get({ postgres: async () => Promise.reject(new Error("password authentication failed for user x")), storage: async () => {} }, "/readyz");
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { ok: false, service: "probe", down: ["postgres"] });
  } finally {
    console.error = quiet;
  }
});

test("readyz answers 200 when every part answers, and healthz never asks them", async () => {
  assert.equal((await get({ postgres: async () => {} }, "/readyz")).status, 200);
  assert.equal((await get({ postgres: async () => Promise.reject(new Error("down")) }, "/healthz")).status, 200);
});
