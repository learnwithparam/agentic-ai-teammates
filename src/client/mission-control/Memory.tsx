import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { problemText } from "@/lib/http";
import { get, post, type SignedIn, type Teammate, TeammateMemory } from "./api";
import { Section } from "./Section";

// What a teammate remembers between runs, as the files it reads. An admin deletes a note that is
// wrong, so no later run acts on it. Someone who only views the teammate reads its instructions.

type File = TeammateMemory["files"][number];

const NOTE = /^notes\/(.+)\.md$/;
const PROGRESS = /^progress\/(.+)\.md$/;

function words(topic: string) {
  return topic.replace(/-/g, " ");
}

// Each file under a name a person reads, with one line on what it is for.
function titleOf(path: string): { title: string; hint: string } {
  if (path === "instructions.md") return { title: "Instructions", hint: "What an admin told it to do. It reads them on every run." };
  if (path === "index.md") return { title: "What it keeps notes on", hint: "One line per note. It reads this list first and opens a note when it needs it." };
  if (path === "reported.md") return { title: "What it told you", hint: "The results it reported to you." };
  const note = path.match(NOTE);
  if (note) return { title: `Note: ${words(note[1])}`, hint: "Something it learned and keeps for next time." };
  const progress = path.match(PROGRESS);
  if (progress) return { title: `Where it got to: ${words(progress[1])}`, hint: "A job that takes more than one run." };
  return { title: path, hint: "A file it keeps." };
}

// Its instructions first, then what it told you, its list of notes, the notes and its progress.
const ORDER = [/^instructions\.md$/, /^reported\.md$/, /^index\.md$/, NOTE, PROGRESS];

function rank(path: string) {
  const found = ORDER.findIndex((pattern) => pattern.test(path));
  return found === -1 ? ORDER.length : found;
}

function MemoryFile({ file, teammate, mayDelete, onDeleted }: { file: File; teammate: string; mayDelete: boolean; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const topic = file.path.match(NOTE)?.[1];
  const { title, hint } = titleOf(file.path);

  async function remove() {
    setBusy(true);
    setProblem(null);
    try {
      await post(`/api/teammates/${teammate}/memory/notes/${topic}`, {}, "DELETE");
      onDeleted();
    } catch (error) {
      setProblem(problemText(error, "The note was not deleted. Try again."));
      setBusy(false);
    }
  }

  return (
    <Section title={title} hint={hint}>
      <pre className="max-h-80 overflow-y-auto rounded-md bg-muted/60 p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap">{file.text.trim() || "Empty."}</pre>
      {topic && mayDelete && (
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={remove} disabled={busy}>
            Delete note
          </Button>
          {problem && <p className="text-sm text-fail">{problem}</p>}
        </div>
      )}
    </Section>
  );
}

export function Memory({ teammate, me }: { teammate: Teammate; me: SignedIn }) {
  const [memory, setMemory] = useState<TeammateMemory | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(() => {
    get(`/api/teammates/${teammate.id}/memory`, TeammateMemory)
      .then(setMemory)
      .catch((error) => setProblem(problemText(error)));
  }, [teammate.id]);
  useEffect(load, [load]);

  if (problem) return <p className="p-4 text-sm text-fail">{problem}</p>;
  if (!memory) return <p className="p-4 text-sm text-muted-foreground">Loading what it remembers.</p>;
  const admin = me.roles.includes("admin");

  return (
    <div className="flex flex-col gap-5 p-4">
      {!memory.full && <p className="rounded-lg bg-muted px-4 py-3 text-sm">You can read its instructions. An admin or an approver also sees its notes.</p>}
      {memory.files.length === 0 && <p className="text-sm text-muted-foreground">It remembers nothing yet. It writes notes as it works.</p>}
      {[...memory.files].sort((first, second) => rank(first.path) - rank(second.path)).map((file) => (
        <MemoryFile key={file.path} file={file} teammate={teammate.id} mayDelete={admin} onDeleted={load} />
      ))}
    </div>
  );
}
