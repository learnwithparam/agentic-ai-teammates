import { useEffect, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Audit, type AuditEntry, get, type OutboxMessage, type Teammate } from "./api";
import { type ToneName, Tone } from "./Tone";
import { targetLabel, when } from "./words";

// Everything that left Mission Control, and everything a person changed. The audit log is the
// record an auditor reads: who decided, paused or changed what, and when.

const OUTBOX_TONES: Record<OutboxMessage["status"], [ToneName, string]> = {
  draft: ["wait", "Waiting for you"],
  queued: ["busy", "About to send"],
  sending: ["busy", "Sending"],
  sent: ["pass", "Sent"],
  discarded: ["quiet", "Thrown away"],
  dead: ["fail", "Gave up"],
};

const ACTIONS: Record<string, string> = {
  "approval.approved": "Approved",
  "approval.denied": "Denied",
  "teammate.changed": "Changed a teammate",
  "instructions.changed": "Changed the instructions",
  "rule.changed": "Changed a rule",
  "outbox.released": "Sent a draft",
  "outbox.discarded": "Threw away a draft",
};

function OutboxTable({ outbox, teammates }: { outbox: OutboxMessage[]; teammates: Teammate[] }) {
  if (outbox.length === 0) return <p className="text-sm text-muted-foreground">No teammate has written anything to send yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>What</TableHead>
          <TableHead>Teammate</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Written</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {outbox.map((message) => {
          const [tone, label] = OUTBOX_TONES[message.status];
          return (
            <TableRow key={message.id}>
              <TableCell className="max-w-[28rem] whitespace-normal">
                <p className="font-medium">{message.title}</p>
                <p className="text-xs text-muted-foreground">
                  {targetLabel(message.target)}
                  {message.error ? `. ${message.error}` : ""}
                </p>
              </TableCell>
              <TableCell>{teammates.find((mate) => mate.id === message.teammate)?.name ?? message.teammate}</TableCell>
              <TableCell>
                <Tone tone={tone}>{label}</Tone>
              </TableCell>
              <TableCell className="text-right text-muted-foreground tabular-nums">{when(message.createdAt)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function AuditTable() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    get("/api/audit", Audit)
      .then(({ entries: loaded }) => setEntries(loaded))
      .catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
  }, []);
  if (problem) return <p className="text-sm text-fail">{problem}</p>;
  if (!entries) return <p className="text-sm text-muted-foreground">Loading the audit log.</p>;
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">No one has decided or changed anything yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Who</TableHead>
          <TableHead>Did</TableHead>
          <TableHead>To</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>{entry.actor}</TableCell>
            <TableCell>{ACTIONS[entry.action] ?? entry.action}</TableCell>
            <TableCell className="max-w-[16rem] truncate font-mono text-xs" title={entry.subject}>
              {entry.subject}
            </TableCell>
            <TableCell className="text-right text-muted-foreground tabular-nums">{when(entry.at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Activity({ outbox, teammates }: { outbox: OutboxMessage[]; teammates: Teammate[] }) {
  return (
    <div className="flex flex-col gap-5 p-4">
      <section className="rounded-xl border bg-card p-4">
        <h2 className="font-display text-base font-semibold">Outbox</h2>
        <p className="mb-3 text-sm text-muted-foreground">Every message a teammate wrote, and what became of it.</p>
        <OutboxTable outbox={outbox} teammates={teammates} />
      </section>
      <section className="rounded-xl border bg-card p-4">
        <h2 className="font-display text-base font-semibold">Audit log</h2>
        <p className="mb-3 text-sm text-muted-foreground">Every decision and change a person made.</p>
        <AuditTable />
      </section>
    </div>
  );
}
