import { Inbox, LogOut, MessageSquare, ReceiptText, Wallet } from "lucide-react";
import { type ComponentProps, type MouseEvent, type ReactNode, useState } from "react";
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
import { type Board, type SignedIn, signOut, type Teammate } from "./api";
import { Home } from "./Home";
import { needsYou } from "./needs-you";
import { pathFor, type Route } from "./route";
import { RunSheet } from "./RunSheet";
import { Spend } from "./Spend";
import { TeammatePage } from "./TeammatePage";
import { Thread } from "./Thread";
import { type ToneName, StatusDot } from "./Tone";
import { useBoard } from "./use-board";
import { useRoute } from "./use-route";

// The page. The sidebar holds what waits for you, the teammates, and the pages about the whole
// company. A teammate opens its own page. Its conversation sits beside it on a wide screen, and
// opens in a sheet from the top bar on a narrower one.

export function statusOf(teammate: Teammate): [ToneName, string] {
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

// A sidebar entry is a real link, so it opens in a new tab too. A plain click stays on the page.
// The menu button styles the link, so every other property passes through to it.
function NavLink({ route, goTo, children, ...rest }: { route: Route; goTo: (route: Route) => void; children: ReactNode } & ComponentProps<"a">) {
  const onClick = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    goTo(route);
  };
  return (
    <a {...rest} href={pathFor(route)} onClick={onClick}>
      {children}
    </a>
  );
}

function TeammateFilter({ teammates, chosen, onChoose }: { teammates: Teammate[]; chosen: string | null; onChoose: (id: string | null) => void }) {
  return (
    <label className="flex items-center gap-2 px-4 pt-4 text-sm">
      <span className="text-muted-foreground">Show</span>
      <select value={chosen ?? ""} onChange={(event) => onChoose(event.target.value || null)} className="h-8 rounded-md border bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <option value="">Every teammate</option>
        {teammates.map((mate) => (
          <option key={mate.id} value={mate.id}>
            {mate.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function titleOf(route: Route, teammate: Teammate | null) {
  if (route.page === "home") return "Needs you";
  if (route.page === "teammate") return teammate?.name ?? "No such teammate";
  return route.page === "activity" ? "Activity" : "Spend";
}

function Main({ route, board, me, goTo, refresh, onOpenRun }: { route: Route; board: Board; me: SignedIn; goTo: (route: Route) => void; refresh: () => void; onOpenRun: (id: string) => void }) {
  if (route.page === "home") return <Home board={board} me={me} onOpenRun={onOpenRun} refresh={refresh} goTo={goTo} />;
  if (route.page === "teammate") {
    const teammate = board.teammates.find((mate) => mate.id === route.id);
    if (!teammate) return <p className="p-6 text-sm text-muted-foreground">There is no teammate here. Choose one on the left.</p>;
    return <TeammatePage key={teammate.id} teammate={teammate} tab={route.tab} board={board} me={me} goTo={goTo} refresh={refresh} onOpenRun={onOpenRun} />;
  }
  const chosen = route.teammate;
  const shown = chosen ? board.teammates.filter((mate) => mate.id === chosen) : board.teammates;
  return (
    <>
      <TeammateFilter teammates={board.teammates} chosen={chosen} onChoose={(id) => goTo({ page: route.page, teammate: id })} />
      {route.page === "activity" ? (
        <Activity outbox={board.outbox.filter((message) => !chosen || message.teammate === chosen)} teammates={board.teammates} />
      ) : (
        <Spend spend={board.spend.filter((day) => !chosen || day.teammate === chosen)} teammates={shown} />
      )}
    </>
  );
}

export function App({ me }: { me: SignedIn }) {
  const { board, error, refresh } = useBoard();
  const [route, goTo] = useRoute();
  const [runId, setRunId] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);

  if (!board) {
    return (
      <main className="grid min-h-svh place-items-center p-6 text-center">
        <p className={error ? "text-fail" : "text-muted-foreground"}>{error ?? "Loading Mission Control."}</p>
      </main>
    );
  }

  // The conversation belongs to a teammate, so it shows on that teammate's page only.
  const teammate = route.page === "teammate" ? (board.teammates.find((mate) => mate.id === route.id) ?? null) : null;
  const waiting = needsYou(board).length;

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="px-4 pt-4">
          <p className="font-display text-lg leading-tight font-semibold">Mission Control</p>
          <p className="text-xs text-muted-foreground">{me.company}</p>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={route.page === "home"}>
                    <NavLink route={{ page: "home" }} goTo={goTo}>
                      <Inbox />
                      <span>Needs you</span>
                    </NavLink>
                  </SidebarMenuButton>
                  {waiting > 0 && <SidebarMenuBadge aria-label={`${waiting} waiting for you`}>{waiting}</SidebarMenuBadge>}
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Teammates</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {board.teammates.map((mate) => {
                  const [tone, label] = statusOf(mate);
                  return (
                    <SidebarMenuItem key={mate.id}>
                      <SidebarMenuButton asChild isActive={teammate?.id === mate.id} tooltip={label} className="h-auto py-1.5">
                        <NavLink route={{ page: "teammate", id: mate.id, tab: "work" }} goTo={goTo}>
                          <StatusDot tone={tone} label={label} />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{mate.name}</span>
                            <span className="truncate text-xs text-muted-foreground">{label}</span>
                          </span>
                        </NavLink>
                      </SidebarMenuButton>
                      {mate.waiting > 0 && <SidebarMenuBadge aria-label={`${mate.waiting} waiting for you`}>{mate.waiting}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Company</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {(
                  [
                    ["activity", "Activity", ReceiptText],
                    ["spend", "Spend", Wallet],
                  ] as const
                ).map(([page, label, Icon]) => (
                  <SidebarMenuItem key={page}>
                    <SidebarMenuButton asChild isActive={route.page === page}>
                      <NavLink route={{ page, teammate: null }} goTo={goTo}>
                        <Icon />
                        <span>{label}</span>
                      </NavLink>
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
          <h1 className="min-w-0 flex-1 truncate font-display text-lg leading-tight font-semibold">{titleOf(route, teammate)}</h1>
          {error && <p className="hidden text-sm text-fail sm:block">{error}</p>}
          {teammate && (
            <Button variant="outline" size="sm" className="2xl:hidden" onClick={() => setTalking(true)}>
              <MessageSquare />
              <span className="sm:hidden">Talk</span>
              <span className="hidden sm:inline">Talk to {teammate.name}</span>
            </Button>
          )}
        </header>
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto">
            <Main route={route} board={board} me={me} goTo={goTo} refresh={refresh} onOpenRun={setRunId} />
          </main>
          {teammate && (
            <aside aria-label={`Conversation with ${teammate.name}`} className="hidden w-96 shrink-0 flex-col border-l 2xl:flex">
              <header className="border-b px-4 py-3">
                <h2 className="font-display text-base font-semibold">Talk to {teammate.name}</h2>
                <p className="text-xs text-muted-foreground">Only you see this conversation.</p>
              </header>
              <Thread key={teammate.id} teammate={teammate} />
            </aside>
          )}
        </div>
      </SidebarInset>

      {teammate && (
        <Sheet open={talking} onOpenChange={setTalking}>
          <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
            <SheetHeader className="border-b">
              <SheetTitle>Talk to {teammate.name}</SheetTitle>
              <SheetDescription>Only you see this conversation.</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1">{talking && <Thread key={teammate.id} teammate={teammate} />}</div>
          </SheetContent>
        </Sheet>
      )}

      <RunSheet runId={runId} onClose={() => setRunId(null)} />
    </SidebarProvider>
  );
}
