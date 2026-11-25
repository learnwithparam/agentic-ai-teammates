import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// A small label whose colour says how things stand. The words always say it too, so the colour
// is never the only sign.

export type ToneName = "pass" | "wait" | "fail" | "quiet" | "busy";

const TONES: Record<ToneName, string> = {
  pass: "bg-pass-soft text-pass",
  wait: "bg-wait-soft text-wait",
  fail: "bg-fail-soft text-fail",
  quiet: "bg-muted text-muted-foreground",
  busy: "bg-accent text-accent-foreground",
};

export function Tone({ tone, children, className }: { tone: ToneName; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>{children}</span>;
}

// The dot beside a teammate's name in the roster.
export function StatusDot({ tone, label }: { tone: ToneName; label: string }) {
  const colour = { pass: "bg-pass", wait: "bg-wait", fail: "bg-fail", quiet: "bg-muted-foreground/40", busy: "bg-foreground animate-pulse" }[tone];
  return <span role="img" aria-label={label} title={label} className={cn("inline-block size-2 shrink-0 rounded-full", colour)} />;
}
