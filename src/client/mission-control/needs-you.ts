import type { Approval, Board, OutboxMessage } from "./api";

// What waits for a person: approval cards not yet decided and drafts not yet sent, oldest first,
// so the card that has waited longest is the one seen first.

export type Waiting = { kind: "approval"; approval: Approval; at: string } | { kind: "draft"; message: OutboxMessage; at: string };

export function needsYou(board: Pick<Board, "approvals" | "outbox">, teammate: string | null = null): Waiting[] {
  const ours = (row: { teammate: string }) => teammate === null || row.teammate === teammate;
  const cards: Waiting[] = board.approvals.filter((approval) => approval.status === "pending" && ours(approval)).map((approval) => ({ kind: "approval", approval, at: approval.createdAt }));
  const drafts: Waiting[] = board.outbox.filter((message) => message.status === "draft" && ours(message)).map((message) => ({ kind: "draft", message, at: message.createdAt }));
  return [...cards, ...drafts].sort((first, second) => first.at.localeCompare(second.at));
}

export function teammateOf(item: Waiting): string {
  return item.kind === "approval" ? item.approval.teammate : item.message.teammate;
}
