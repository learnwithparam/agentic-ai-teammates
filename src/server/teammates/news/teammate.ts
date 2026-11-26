import { attacks } from "./attacks";
import { DIGEST, defineTeammate } from "../define";
import { EDITION_TIMER, newsTeammate } from "./work";

export const news = defineTeammate({
  kind: "news",
  id: "news",
  name: "News teammate",
  purpose: "Writes the company's morning news from public sources, linking only to stories a source gave that day.",
  asks: ["What did you pick today, and why?", "Which sources do you read?"],
  tools: ["news.collect", "news.read", "news.publish", "memory.read",
    "memory.reported", "team.remind", "team.digest"],
  // The edition at seven on a working morning, and the day's summary in the evening.
  schedules: [{ name: EDITION_TIMER, cron: "0 7 * * 1-5", label: "Morning edition" }, DIGEST],
  listens: [],
  defaults: { dailyBudgetUsd: 0.5 },
  // It answers questions about the day's news, and never sets work for itself.
  capabilities: { chat: { mode: "read", reads: ["news.read"] }, followUps: false, digest: true, tidy: false },
  evaluate: "data/news/eval.ts",
  attacks,
  work: newsTeammate,
});
