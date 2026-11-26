import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute, pathFor, type Route } from "./route";

test("every screen has its own address, and the address opens that screen again", () => {
  const routes: Route[] = [
    { page: "home" },
    { page: "teammate", id: "invoices", tab: "work" },
    { page: "teammate", id: "payments", tab: "schedule" },
    { page: "teammate", id: "news", tab: "memory" },
    { page: "teammate", id: "invoices", tab: "settings" },
    { page: "activity", teammate: null },
    { page: "spend", teammate: "payments" },
  ];
  for (const route of routes) {
    const [pathname, search = ""] = pathFor(route).split("?");
    assert.deepEqual(parseRoute(pathname, search ? `?${search}` : ""), route);
  }
});

test("a link from the first pages lands on the same screen", () => {
  assert.deepEqual(parseRoute("/", "?teammate=invoices"), { page: "teammate", id: "invoices", tab: "work" });
  assert.deepEqual(parseRoute("/", "?view=settings&teammate=payments"), { page: "teammate", id: "payments", tab: "settings" });
  assert.deepEqual(parseRoute("/", "?view=spend&teammate=payments"), { page: "spend", teammate: "payments" });
  assert.deepEqual(parseRoute("/", "?view=activity"), { page: "activity", teammate: null });
  assert.deepEqual(parseRoute("/", "?view=board"), { page: "home" });
  assert.deepEqual(parseRoute("/teammates/news/unknown", ""), { page: "teammate", id: "news", tab: "work" });
});
