import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { Pool } from "pg";
import { dispatchOnce } from "./dispatcher-loop";
import { GatewayError } from "./gateway-client";
import { Outbox, OUTBOX_SETTINGS } from "./outbox";
import { testDatabase } from "./test-database";

// The dispatcher against a real Postgres. The gateway here answers from a script, so a test can
// make a send fail in the way it needs.

let pool: Pool;
let close: () => Promise<void>;
let outbox: Outbox;

before(async () => {
  ({ pool, close } = await testDatabase());
  outbox = new Outbox(pool);
});
after(async () => close());
// Each test starts with no pacing and an empty outbox, so one test's send never holds back the next.
beforeEach(async () => {
  await pool.query("DELETE FROM outbox_pacing");
  await pool.query("DELETE FROM outbox");
});

async function queue(status: "draft" | "queued" = "queued") {
  const { message } = await outbox.add({
    company: "bramble", teammate: "invoices", runId: null, target: "lmail.send", title: "Reply to billing@lumen.example",
    idempotencyKey: `reply:${randomUUID()}`, payload: { to: "billing@lumen.example" }, status,
  });
  return message;
}

async function row(id: string) {
  const { rows } = await pool.query("SELECT status, attempts, error, result, available_at > now() AS later FROM outbox WHERE id = $1", [id]);
  return rows[0];
}

const answers = (...script: (unknown | Error)[]) => {
  const keys: string[] = [];
  return {
    keys,
    async dispatch(_target: string, body: { idempotencyKey: string }) {
      keys.push(body.idempotencyKey);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
};

test("a queued message is sent once, with its idempotency key, and keeps the answer", async () => {
  const message = await queue();
  const gateway = answers({ id: "lmail-1" });
  assert.equal((await dispatchOnce(outbox, gateway))?.outcome, "sent");
  assert.deepEqual(gateway.keys, [message.idempotencyKey]);
  const after = await row(message.id);
  assert.equal(after.status, "sent");
  assert.deepEqual(after.result, { id: "lmail-1" });
  assert.equal(await dispatchOnce(outbox, gateway), null);
});

test("a draft is never sent until a person releases it", async () => {
  const draft = await queue("draft");
  assert.equal(await dispatchOnce(outbox, answers({ id: "x" })), null);
  assert.equal((await row(draft.id)).status, "draft");
});

test("a failure a retry can fix waits and tries again; one it cannot is dead at once", async () => {
  const flaky = await queue();
  assert.equal((await dispatchOnce(outbox, answers(new GatewayError(502, "LMail timed out.", true))))?.outcome, "retry");
  const waiting = await row(flaky.id);
  assert.deepEqual([waiting.status, waiting.attempts, waiting.later, waiting.error], ["queued", 1, true, "LMail timed out."]);

  await pool.query("DELETE FROM outbox_pacing");
  const refused = await queue();
  assert.equal((await dispatchOnce(outbox, answers(new GatewayError(502, "LMail has no mailbox.", false))))?.outcome, "dead");
  assert.equal((await row(refused.id)).status, "dead");
});

test("a network failure counts as one a retry can fix", async () => {
  const message = await queue();
  assert.equal((await dispatchOnce(outbox, answers(new TypeError("fetch failed"))))?.outcome, "retry");
  assert.equal((await row(message.id)).status, "queued");
});

test("after the last allowed attempt the message is dead, with the last reason", async () => {
  const message = await queue();
  await pool.query("UPDATE outbox SET attempts = $2 WHERE id = $1", [message.id, OUTBOX_SETTINGS.maxAttempts - 1]);
  assert.equal((await dispatchOnce(outbox, answers(new GatewayError(503, "Still down.", true))))?.outcome, "dead");
  const after = await row(message.id);
  assert.deepEqual([after.status, after.error], ["dead", "Still down."]);
});

test("two sends to one target are spaced out, so the second waits its turn", async () => {
  // A minute of spacing, so a slow machine never takes longer than the gap between the two sends.
  const spacing = OUTBOX_SETTINGS.spacingMs;
  OUTBOX_SETTINGS.spacingMs = 60_000;
  try {
    await queue();
    await queue();
    const gateway = answers({ id: "a" }, { id: "b" });
    assert.equal((await dispatchOnce(outbox, gateway))?.outcome, "sent");
    assert.equal(await dispatchOnce(outbox, gateway), null);
    assert.equal(gateway.keys.length, 1);
  } finally {
    OUTBOX_SETTINGS.spacingMs = spacing;
  }
});
