import assert from "node:assert/strict";
import { test } from "node:test";
import type { Approval, OutboxMessage } from "./api";
import { needsYou, teammateOf } from "./needs-you";

const card = (id: string, teammate: string, createdAt: string, status: Approval["status"] = "pending") => ({ id, teammate, createdAt, status }) as Approval;
const draft = (id: string, teammate: string, createdAt: string, status: OutboxMessage["status"] = "draft") => ({ id, teammate, createdAt, status }) as OutboxMessage;

test("what needs you is every undecided card and unsent draft, the oldest first", () => {
  const board = {
    approvals: [card("new", "invoices", "2026-11-26T09:00:00Z"), card("decided", "invoices", "2026-11-20T09:00:00Z", "approved"), card("old", "payments", "2026-11-23T09:00:00Z")],
    outbox: [draft("letter", "news", "2026-11-24T09:00:00Z"), draft("sent", "news", "2026-11-21T09:00:00Z", "sent")],
  };
  const ids = (items: ReturnType<typeof needsYou>) => items.map((item) => (item.kind === "approval" ? item.approval.id : item.message.id));
  assert.deepEqual(ids(needsYou(board)), ["old", "letter", "new"]);
  assert.deepEqual(ids(needsYou(board, "invoices")), ["new"]);
  assert.deepEqual(needsYou(board).map(teammateOf), ["payments", "news", "invoices"]);
});
