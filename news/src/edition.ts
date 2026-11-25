import { z } from "zod";

// The files the news teammate publishes next to this page, on GitHub Pages or Mission Control: data/today.json, one data/<day>.json
// per edition, and data/days.json, the list of days, newest first.

const Card = z.object({
  headline: z.string(),
  bullets: z.array(z.string()),
  whyItMatters: z.string(),
  url: z.url(),
  source: z.string(),
  topic: z.string(),
});

export const Edition = z.object({ day: z.iso.date(), publishedAt: z.string(), cards: z.array(Card).min(1) });
export type Edition = z.infer<typeof Edition>;
export type Card = z.infer<typeof Card>;

const Days = z.array(z.iso.date());

export class NoEdition extends Error {}

async function getJson(path: string): Promise<unknown> {
  // Asking for JSON means a lapsed Mission Control sign-in answers 401, not the sign-in page.
  const response = await fetch(path, { cache: "no-cache", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) throw new NoEdition("There is no news here yet.");
  if (response.status === 401) throw new Error("Your sign-in has ended. Reload the page to sign in again.");
  if (!response.ok) throw new Error(`The news did not load (${response.status}).`);
  return response.json();
}

// A day from the address, such as ?day=2026-11-25, or today's edition.
export async function loadEdition(day: string | null): Promise<Edition> {
  return Edition.parse(await getJson(day ? `data/${day}.json` : "data/today.json"));
}

export async function loadDays(): Promise<string[]> {
  return Days.parse(await getJson("data/days.json"));
}

// "Wednesday 25 November", read on the day's own calendar date, whatever the reader's time zone.
export function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

// The next card to show, kept within the edition. The card after the last is the closing page.
export function step(index: number, by: number, cards: number): number {
  return Math.min(Math.max(index + by, 0), cards);
}
