// Where the person is, read from the address and written back to it, so a link or a reload opens
// the same screen. Home is what waits for you; each teammate has its own page with four tabs;
// Activity and Spend are about the whole company.

export const TABS = ["work", "schedule", "memory", "settings"] as const;
export type Tab = (typeof TABS)[number];

export type Route =
  | { page: "home" }
  | { page: "teammate"; id: string; tab: Tab }
  | { page: "activity" | "spend"; teammate: string | null };

const TEAMMATE_PATH = /^\/teammates\/([a-z0-9-]+)(?:\/([a-z]+))?\/?$/;

function tabOf(word: string | undefined): Tab {
  return TABS.find((tab) => tab === word) ?? "work";
}

// The first pages kept the view and the teammate in the query, as ?view=settings&teammate=payments.
// Those links still land on the same screen.
function fromOldQuery(query: URLSearchParams): Route | null {
  const view = query.get("view");
  const teammate = query.get("teammate");
  if (view === "activity" || view === "spend") return { page: view, teammate };
  if (!teammate) return null;
  return { page: "teammate", id: teammate, tab: view === "settings" ? "settings" : "work" };
}

export function parseRoute(pathname: string, search: string): Route {
  const query = new URLSearchParams(search);
  const found = pathname.match(TEAMMATE_PATH);
  if (found) return { page: "teammate", id: found[1], tab: tabOf(found[2]) };
  if (pathname === "/activity" || pathname === "/spend") {
    return { page: pathname === "/activity" ? "activity" : "spend", teammate: query.get("teammate") };
  }
  return fromOldQuery(query) ?? { page: "home" };
}

export function pathFor(route: Route): string {
  if (route.page === "home") return "/";
  if (route.page === "teammate") return route.tab === "work" ? `/teammates/${route.id}` : `/teammates/${route.id}/${route.tab}`;
  return route.teammate ? `/${route.page}?teammate=${encodeURIComponent(route.teammate)}` : `/${route.page}`;
}
