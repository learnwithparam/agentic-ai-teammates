import { LayoutGrid, LogOut, MessageSquare, ReceiptText, Settings as SettingsIcon, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Activity } from "./Activity";
import { type SignedIn, signOut, type Teammate } from "./api";
import { Board } from "./Board";
import { RunSheet } from "./RunSheet";
import { Settings } from "./Settings";
import { Spend } from "./Spend";
import { Thread } from "./Thread";
import { type ToneName, StatusDot } from "./Tone";
import { useBoard } from "./use-board";

// The page: teammates down the left, the work in the middle, and a conversation with the chosen
// teammate on the right. On a narrower screen the conversation opens as a sheet from a button in the top bar.

const VIEWS = [
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "activity", label: "Activity", icon: ReceiptText },
  { id: "spend", label: "Spend", icon: Wallet },
  { id: "settings", label: "Settings", icon: SettingsIcon },
] as const;
type View = (typeof VIEWS)[number]["id"];

function statusOf(teammate: Teammate): [ToneName, string] {
  if (teammate.paused) return ["quiet", "Paused"];
  if (teammate.lastRun?.status === "running") return ["busy", "Working"];
  if (teammate.waiting > 0) return ["wait", "Waiting for you"];
  return ["pass", "Ready"];
}

function roleName(me: SignedIn) {
  if (me.roles.includes("admin")) return "Admin";
  if (me.roles.includes("approver")) return "Approver";
  return "Viewer";
}

// The view and the chosen teammate live in the address, so a link opens the same screen.
function fromAddress(): { view: View; teammate: string | null } {
  const query = new URLSearchParams(window.location.search);
  const view = VIEWS.find((item) => item.id === query.get("view"))?.id ?? "board";
  return { view, teammate: query.get("teammate") };
}

export function App({ me }: { me: SignedIn }) {
  const { board, error, refresh } = useBoard();
  const [view, setView] = useState<View>(() => fromAddress().view);
  const [chosen, setChosen] = useState<string | null>(() => fromAddress().teammate);
  const [runId, setRunId] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams();
    if (view !== "board") query.set("view", view);
    if (chosen) query.set("teammate", chosen);
    const search = query.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  }, [view, chosen]);

  if (!board) {
    return (
      <main className="grid min-h-svh place-items-center p-6 text-center">
        <p className={error ? "text-fail" : "text-muted-foreground"}>{error ?? "Loading Mission Control."}</p>
      </main>
    );
  }

  const teammate = board.teammates.find((mate) => mate.id === chosen) ?? null;
  // Settings and the conversation are about one teammate. With none chosen, they use the first.
  const focus = teammate ?? board.teammates[0];
  const title = view === "board" ? (teammate ? teammate.name : "All teammates") : `${VIEWS.find((item) => item.id === view)?.label}${view === "settings" ? `: ${focus.name}` : ""}`;

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="px-4 pt-4">
          <p className="font-display text-lg leading-tight font-semibold">Mission Control</p>
          <p className="text-xs text-muted-foreground">{me.company}</p>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Teammates</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={!chosen} onClick={() => setChosen(null)}>
                    <span>All teammates</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {board.teammates.map((mate) => {
                  const [tone, label] = statusOf(mate);
                  return (
                    <SidebarMenuItem key={mate.id}>
                      <SidebarMenuButton isActive={chosen === mate.id} onClick={() => setChosen(mate.id)} tooltip={label}>
                        <StatusDot tone={tone} label={label} />
                        <span>{mate.name}</span>
                      </SidebarMenuButton>
                      {mate.waiting > 0 && <SidebarMenuBadge aria-label={`${mate.waiting} waiting for you`}>{mate.waiting}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>See</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {VIEWS.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton isActive={view === item.id} onClick={() => setView(item.id)}>
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="border-t p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{me.name}</p>
              <p className="text-xs text-muted-foreground">{roleName(me)}</p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => signOut()}>
              <LogOut />
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="h-svh min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-lg leading-tight font-semibold">{title}</h1>
            {view === "board" && teammate?.purpose && <p className="hidden truncate text-xs text-muted-foreground md:block">{teammate.purpose}</p>}
          </div>
          {error && <p className="hidden text-sm text-fail sm:block">{error}</p>}
          <Button variant="outline" size="sm" className="2xl:hidden" onClick={() => setTalking(true)}>
            <MessageSquare />
            <span className="sm:hidden">Talk</span>
            <span className="hidden sm:inline">Talk to {focus.name}</span>
          </Button>
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto">
            {view === "board" && <Board board={board} me={me} teammate={chosen} onOpenRun={setRunId} refresh={refresh} />}
            {view === "activity" && <Activity outbox={board.outbox} teammates={board.teammates} />}
            {view === "spend" && <Spend spend={board.spend} teammates={board.teammates} />}
            {view === "settings" && <Settings key={focus.id} teammate={focus} me={me} onSaved={refresh} />}
          </main>
          <aside aria-label={`Conversation with ${focus.name}`} className="hidden w-96 shrink-0 flex-col border-l 2xl:flex">
            <header className="border-b px-4 py-3">
              <h2 className="font-display text-base font-semibold">Talk to {focus.name}</h2>
              <p className="text-xs text-muted-foreground">Only you see this conversation.</p>
            </header>
            <Thread key={focus.id} teammate={focus} />
          </aside>
        </div>
      </SidebarInset>

      <Sheet open={talking} onOpenChange={setTalking}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b">
            <SheetTitle>Talk to {focus.name}</SheetTitle>
            <SheetDescription>Only you see this conversation.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">{talking && <Thread key={focus.id} teammate={focus} />}</div>
        </SheetContent>
      </Sheet>

      <RunSheet runId={runId} onClose={() => setRunId(null)} />
    </SidebarProvider>
  );
}
