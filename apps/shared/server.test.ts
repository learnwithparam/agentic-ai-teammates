import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { createApp, listen, LOOPBACK } from "./server";

// On a server the processes share the host's network. A port bound to every interface would be
// open to the internet, beside Caddy. So every listener binds to this machine only.

test("a process listens on this machine only", async () => {
  const server = listen(express(), "Probe", 0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    assert.equal((server.address() as AddressInfo).address, LOOPBACK);
  } finally {
    server.close();
  }
});

test("every listener in the code passes the loopback address", () => {
  const root = new URL("../..", import.meta.url).pathname;
  const sources = ["apps", "src"].flatMap((folder) =>
    readdirSync(join(root, folder), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
      .map((file) => join(folder, file)),
  );
  const calls = sources.flatMap((file) =>
    [...readFileSync(join(root, file), "utf8").matchAll(/\.listen\(([^)]*)/g)].map((match) => ({ file, args: match[1] })),
  );
  assert.ok(calls.length >= 2, "expected the HTTP and SMTP listeners");
  for (const call of calls) assert.match(call.args, /^\w+, LOOPBACK\b/, `${call.file} listens on every interface`);
});

async function get(ready: Parameters<typeof createApp>[1], path: string) {
  const app = createApp("probe", ready);
  const server = app.listen(0, LOOPBACK);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://${LOOPBACK}:${(server.address() as AddressInfo).port}${path}`);
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
