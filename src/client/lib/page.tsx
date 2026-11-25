import { LogOut } from "lucide-react";
import { type ReactNode, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createHttp, problemText } from "./http";
import "@/styles/app.css";

// What every world app (LMail, LDrive, QuirkBooks) shares: who is signed in, the top bar, and
// starting the page. Each app is its own product, so each has its own sign-in at /auth.

export const Person = z.object({
  email: z.string(),
  name: z.string(),
  company: z.string(),
  roles: z.array(z.string()),
});
export type Person = z.infer<typeof Person>;

export const http = createHttp("/auth");

export const isAdmin = (person: Person) => person.roles.includes("admin");

export function TopBar({ product, person, children }: { product: string; person: Person; children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card px-4">
      <p className="font-display text-lg font-semibold">{product}</p>
      <div className="min-w-0 flex-1">{children}</div>
      <div className="hidden min-w-0 text-right sm:block">
        <p className="truncate text-sm font-medium">{person.name}</p>
        <p className="truncate text-xs text-muted-foreground">{person.email}</p>
      </div>
      <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => http.signOut()}>
        <LogOut />
      </Button>
    </header>
  );
}

// Who is signed in comes first. Without a session, the first call sends the person to sign in.
function Start({ render }: { render: (person: Person) => ReactNode }) {
  const [person, setPerson] = useState<Person | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    http
      .get("/api/me", Person)
      .then(setPerson)
      .catch((error) => setProblem(problemText(error)));
  }, []);
  if (!person) return <main className="grid min-h-svh place-items-center p-6 text-muted-foreground">{problem ?? "Signing you in."}</main>;
  return <TooltipProvider>{render(person)}</TooltipProvider>;
}

export function startPage(render: (person: Person) => ReactNode) {
  const root = document.getElementById("root");
  if (!root) throw new Error("The page has no #root element.");
  createRoot(root).render(
    <StrictMode>
      <Start render={render} />
    </StrictMode>,
  );
}

// Loads one answer and reloads it on demand. A failed load keeps the last answer and says why.
export function useAnswer<T>(path: string | null, shape: z.ZodType<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!path) return;
    let current = true;
    http
      .get(path, shape)
      .then((answer) => {
        if (!current) return;
        setData(answer);
        setError(null);
      })
      .catch((failure) => current && setError(problemText(failure)));
    return () => {
      current = false;
    };
  }, [path, shape, round]);
  return { data, error, reload: () => setRound((value) => value + 1) };
}

export const dateTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const dayOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
