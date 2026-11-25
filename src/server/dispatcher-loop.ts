import { GatewayError, type GatewayClient } from "./gateway-client";
import type { Outbox } from "./outbox";

// One step of the dispatcher: take the next message that is due, ask the gateway to send it,
// and record what happened. The dispatcher holds only its gateway token; the gateway holds the
// LMail key and, for news on GitHub, the GitHub token.

export type Dispatched = { id: string; title: string; outcome: "sent" | "retry" | "dead"; reason?: string };

export async function dispatchOnce(outbox: Outbox, gateway: Pick<GatewayClient, "dispatch">): Promise<Dispatched | null> {
  const message = await outbox.claim();
  if (!message) return null;
  try {
    const result = await gateway.dispatch(message.target, { company: message.company, idempotencyKey: message.idempotencyKey, payload: message.payload });
    await outbox.sent(message.id, result);
    return { id: message.id, title: message.title, outcome: "sent" };
  } catch (error) {
    // The gateway says whether a retry can help. A network failure or a timeout always can.
    const retryable = error instanceof GatewayError ? error.retryable : true;
    const reason = (error instanceof Error ? error.message : "The send failed.").slice(0, 500);
    const outcome = await outbox.failed(message.id, reason, retryable);
    return { id: message.id, title: message.title, outcome, reason };
  }
}

// Sends everything that is due now, one message at a time, and says what it did.
export async function drain(outbox: Outbox, gateway: Pick<GatewayClient, "dispatch">): Promise<Dispatched[]> {
  const done: Dispatched[] = [];
  for (let next = await dispatchOnce(outbox, gateway); next; next = await dispatchOnce(outbox, gateway)) done.push(next);
  return done;
}
