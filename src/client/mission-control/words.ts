import { REASONS, type Reason } from "../../server/checks";
import type { InboxEvent, OutboxMessage, StopReason } from "./api";

// The words the board uses for the server's codes. A code with no entry here shows as itself,
// so a new one is visible rather than hidden.

export const STOP_REASONS: Record<StopReason, { label: string; tone: "pass" | "wait" | "fail" | "quiet" }> = {
  sent: { label: "Done", tone: "pass" },
  nothing_to_send: { label: "Nothing to do", tone: "quiet" },
  deferred: { label: "Waiting for you", tone: "wait" },
  handed_to_human: { label: "Handed to you", tone: "wait" },
  failed: { label: "Failed", tone: "fail" },
};

const EVENT_TYPES: Record<string, string> = {
  "mail.received": "New mail",
  "drive.changed": "New file",
  "person.message": "Message from a person",
  "approval.decided": "A person decided",
  "timer.fired": "Timer",
};

const SOURCES: Record<string, string> = {
  lmail: "LMail",
  ldrive: "LDrive",
  person: "Mission Control",
  approval: "Mission Control",
  timer: "Schedule",
};

export function eventLabel(event: Pick<InboxEvent, "type">): string {
  return EVENT_TYPES[event.type] ?? event.type;
}

export function sourceLabel(source: string): string {
  return SOURCES[source] ?? source;
}

export function reasonText(code: string): string {
  return code in REASONS ? REASONS[code as Reason] : code;
}

const TARGETS: Record<OutboxMessage["target"], string> = {
  "lmail.send": "Reply by mail",
  "news.publish": "Publish the news",
  "memory.tidy": "Tidy a note",
};

export function targetLabel(target: OutboxMessage["target"]): string {
  return TARGETS[target];
}

const money = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return "No amount";
  const code = currency ?? "EUR";
  if (!money.has(code)) money.set(code, new Intl.NumberFormat("en-GB", { style: "currency", currency: code }));
  return money.get(code)?.format(amount) ?? `${amount} ${code}`;
}

// Model spend is fractions of a cent, so it keeps more places than an invoice does.
// How many tokens a run used, and how many of them the provider read from its prompt cache.
export function tokensRead(run: { tokens: number; cached_tokens: number }): string {
  const used = `${run.tokens.toLocaleString("en")} tokens`;
  return run.cached_tokens > 0 ? `${used}, ${run.cached_tokens.toLocaleString("en")} read from the cache` : used;
}

// What a teammate wrote over the last two weeks, in one line for the Quiet switch.
export function volumeLine(volume: { days: number; onItsOwn: number; released: number; discarded: number; waiting: number }): string {
  const parts = [
    [volume.onItsOwn, "went out on its own"],
    [volume.released, "sent by a person"],
    [volume.discarded, "thrown away"],
    [volume.waiting, "still waiting"],
  ] as const;
  const said = parts.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`);
  const days = `the last ${volume.days} days`;
  return said.length ? `In ${days}: ${said.join(", ")}.` : `It has written nothing in ${days}.`;
}

export function formatSpend(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// "14:05" today, "24 Nov, 09:12" before.
export function when(iso: string): string {
  const moment = new Date(iso);
  const today = new Date().toDateString() === moment.toDateString();
  return today ? clock.format(moment) : date.format(moment);
}

export function duration(from: string, until: string | null): string {
  const seconds = Math.round(((until ? new Date(until) : new Date()).getTime() - new Date(from).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Steps of 1, 2 or 5 times a power of ten, so every line on the axis reads as a round amount.
export function axisTicks(highest: number): number[] {
  if (highest <= 0) return [0];
  const rough = highest / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power;
  const ticks: number[] = [];
  for (let tick = 0; tick < highest + step; tick += step) ticks.push(Number(tick.toPrecision(6)));
  return ticks;
}

const STALE_AFTER = 3;
const dayName = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

// Working days that ended since a card arrived: Monday to Friday, not counting its own day.
export function workingDaysSince(iso: string, now = new Date()): number {
  const day = new Date(iso);
  day.setHours(12, 0, 0, 0);
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  let count = 0;
  for (day.setDate(day.getDate() + 1); day <= today; day.setDate(day.getDate() + 1)) {
    if (day.getDay() !== 0 && day.getDay() !== 6) count += 1;
  }
  return count;
}

// "Waiting since Tue 24 Nov" once a card has waited three working days, so an old one stands out.
export function waitingSince(iso: string, now = new Date()): string | null {
  return workingDaysSince(iso, now) >= STALE_AFTER ? `Waiting since ${dayName.format(new Date(iso))}` : null;
}

// A time on the company's clock with its day, "Fri 27 Nov, 09:00", the clock a schedule is set in.
export function onClock(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}, ${part("hour")}:${part("minute")}`;
}
