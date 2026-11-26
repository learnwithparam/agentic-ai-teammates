import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Board as BoardData, SignedIn, Teammate } from "./api";
import { Board } from "./Board";
import { Memory } from "./Memory";
import type { Route, Tab } from "./route";
import { Schedule } from "./Schedule";
import { Settings } from "./Settings";
import { Tone } from "./Tone";

// One teammate's own page: what it is for and how it stands, then its work, what it does next,
// what it remembers and how it is set up. Each tab has its own address.

const TAB_LABELS: Record<Tab, string> = { work: "Work", schedule: "Schedule", memory: "Memory", settings: "Settings" };

type Props = { teammate: Teammate; tab: Tab; board: BoardData; me: SignedIn; goTo: (route: Route) => void; refresh: () => void; onOpenRun: (id: string) => void };

export function TeammatePage({ teammate, tab, board, me, goTo, refresh, onOpenRun }: Props) {
  return (
    <Tabs value={tab} onValueChange={(next) => goTo({ page: "teammate", id: teammate.id, tab: next as Tab })} className="h-full gap-0">
      <div className="flex flex-col gap-3 border-b px-4 pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="min-w-0 text-sm text-muted-foreground">{teammate.purpose}</p>
          <span className="flex gap-1.5">
            {teammate.paused ? <Tone tone="quiet">Paused</Tone> : <Tone tone="pass">On duty</Tone>}
            {teammate.quiet && <Tone tone="quiet">Quiet: a person sends every message</Tone>}
          </span>
        </div>
        <TabsList variant="line" className="-mb-px">
          {Object.entries(TAB_LABELS).map(([value, label]) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value="work" className="min-h-0">
        <Board board={board} me={me} teammate={teammate.id} onOpenRun={onOpenRun} refresh={refresh} />
      </TabsContent>
      <TabsContent value="schedule">
        <Schedule teammate={teammate} me={me} onOpenRun={onOpenRun} />
      </TabsContent>
      <TabsContent value="memory">
        <Memory teammate={teammate} me={me} />
      </TabsContent>
      <TabsContent value="settings">
        <Settings teammate={teammate} me={me} onSaved={refresh} />
      </TabsContent>
    </Tabs>
  );
}
