import type { ReactNode } from "react";

// One block of a teammate's page: a title, one line on what it holds, then its rows.
export function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="font-display text-base font-semibold">{title}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{hint}</p>
      {children}
    </section>
  );
}
