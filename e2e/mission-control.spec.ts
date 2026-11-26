import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { setting } from "../src/server/env";
import { Memory } from "../src/server/memory";
import { createS3 } from "../src/server/s3";
import { ensureHarnessTeammate } from "../src/server/teammates/ensure";
import { setTimer } from "../src/server/timers";
import { FOLLOW_UP_PREFIX } from "../src/server/tools/team";
import { PEOPLE, signIn } from "./sign-in";

// What the lessons and the README promise about Mission Control, checked in a real browser against
// the running stack. Each person signs in through Keycloak, and OpenFGA decides what they see.

const COMPANY = "bramble";
const REAL_TEAMMATES = ["Invoice teammate", "News teammate", "Payments teammate"];
const HARNESS = { company: COMPANY, id: "browser-test-attack", kind: "invoice", name: "Browser test harness" };
const FOLLOW_UP = `${FOLLOW_UP_PREFIX}browser-test-${randomUUID()}`;
// A note the invoice teammate keeps, written the way a run writes one. Admins and approvers see it.
const NOTE = { scope: { company: COMPANY, teammate: "invoices" }, topic: "browser-test-harbor-lane", line: "Harbor Lane sends its invoices as PDF only." };

let pool: Pool;
const memory = new Memory(createS3());

test.beforeAll(async () => {
  pool = new Pool({ connectionString: setting("DATABASE_URL") });
  // A harness teammate made the way the eval and attack scripts make theirs. People never see it.
  await ensureHarnessTeammate(pool, HARNESS);
  await memory.ready();
  await memory.addLine(NOTE.scope, NOTE.topic, NOTE.line);
  await setTimer(pool, COMPANY, "invoices", FOLLOW_UP, { at: new Date(Date.now() + 3 * 86_400_000) }, {
    about: "Harbor Lane's reply on the fitting days",
    reason: "Ravi asked in the conversation.",
    person: PEOPLE.ravi,
    task: null,
  });
});

test.afterAll(async () => {
  await pool.query("DELETE FROM timers WHERE company = $1 AND name = $2", [COMPANY, FOLLOW_UP]);
  await pool.query("DELETE FROM teammates WHERE company = $1 AND id = $2", [COMPANY, HARNESS.id]);
  await memory.deleteNote(NOTE.scope, NOTE.topic);
  await pool.end();
});

const sidebar = (page: import("@playwright/test").Page) => page.locator("[data-sidebar='sidebar']");

test("the sidebar lists the three real teammates and never a harness", async ({ page }) => {
  await signIn(page, "ada");
  const roster = sidebar(page).locator("[data-sidebar='group']").filter({ hasText: "Teammates" }).locator("[data-sidebar='menu-item']");
  await expect(roster).toHaveCount(REAL_TEAMMATES.length);
  for (const name of REAL_TEAMMATES) await expect(roster.filter({ hasText: name })).toHaveCount(1);
  await expect(sidebar(page)).not.toContainText(HARNESS.name);
});

test("each teammate has its own page, and every tab has its own address", async ({ page }) => {
  await signIn(page, "ada");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Needs you");
  for (const [id, name] of [["invoices", "Invoice teammate"], ["payments", "Payments teammate"], ["news", "News teammate"]]) {
    await sidebar(page).getByRole("link", { name: new RegExp(name) }).click();
    await expect(page).toHaveURL(new RegExp(`/teammates/${id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(page.getByRole("tab", { name: "Work", selected: true })).toBeVisible();

    await page.getByRole("tab", { name: "Schedule" }).click();
    await expect(page).toHaveURL(new RegExp(`/teammates/${id}/schedule$`));
    await expect(page.getByRole("heading", { name: "Schedules" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Follow-ups" })).toBeVisible();

    await page.getByRole("tab", { name: "Memory" }).click();
    await expect(page).toHaveURL(new RegExp(`/teammates/${id}/memory$`));
    // A teammate shows its files, or says it has none yet. Either way the tab has loaded.
    await expect(page.getByRole("heading", { name: "Instructions" }).or(page.getByText("It remembers nothing yet."))).toBeVisible();

    await page.getByRole("tab", { name: "Settings" }).click();
    await expect(page).toHaveURL(new RegExp(`/teammates/${id}/settings$`));
    await expect(page.getByRole("switch").first()).toBeEnabled();
  }
  // A reload opens the same teammate and the same tab.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("News teammate");
  await expect(page.getByRole("tab", { name: "Settings", selected: true })).toBeVisible();
});

test("an old link lands on the teammate's page, and the company pages open", async ({ page }) => {
  await signIn(page, "ada", "/?teammate=invoices");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Invoice teammate");
  await expect(page).toHaveURL(/\/teammates\/invoices$/);
  for (const name of ["Activity", "Spend"]) {
    await sidebar(page).getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/${name.toLowerCase()}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  }
});

test("Ada sees the teammate's notes and may delete them", async ({ page }) => {
  await signIn(page, "ada", "/teammates/invoices/memory");
  const note = page.locator("section").filter({ hasText: NOTE.line });
  await expect(note).toBeVisible();
  await expect(note.getByRole("button", { name: "Delete note" })).toBeVisible();
});

test("Mei can look, but not decide, change or delete", async ({ page }) => {
  await signIn(page, "mei", "/teammates/invoices/memory");
  await expect(page.getByText("You can read its instructions.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Instructions" })).toBeVisible();
  await expect(page.getByText(NOTE.line)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Note:/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete note" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Settings" }).click();
  for (const toggle of await page.getByRole("switch").all()) await expect(toggle).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Save/ })).toHaveCount(0);

  await page.getByRole("tab", { name: "Work" }).click();
  await expect(page.getByRole("button", { name: /^(Approve|Deny)/ })).toHaveCount(0);

  await page.getByRole("tab", { name: "Schedule" }).click();
  await expect(page.getByText("Harbor Lane's reply on the fitting days")).toHaveCount(0);
});

test("Ravi reads the teammate's notes, but only an admin deletes one", async ({ page }) => {
  await signIn(page, "ravi", "/teammates/invoices/memory");
  const note = page.locator("section").filter({ hasText: NOTE.line });
  await expect(note).toBeVisible();
  await expect(note.getByRole("button", { name: "Delete note" })).toHaveCount(0);
});

test("Ravi sees his follow-up and cancels it, and the timer is gone", async ({ page }) => {
  await signIn(page, "ravi", "/teammates/invoices/schedule");
  const row = page.getByRole("listitem").filter({ hasText: "Harbor Lane's reply on the fitting days" });
  await expect(row).toContainText("Asked by you");
  await row.getByRole("button", { name: "Cancel follow-up" }).click();
  await expect(row).toHaveCount(0);
  const { rows } = await pool.query("SELECT status FROM timers WHERE company = $1 AND name = $2", [COMPANY, FOLLOW_UP]);
  expect(rows.map((timer) => timer.status)).not.toContain("waiting");
});

test("on a phone the conversation opens from the header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "ada", "/teammates/invoices");
  await expect(page.getByRole("complementary", { name: "Conversation with Invoice teammate" })).toBeHidden();
  await page.getByRole("button", { name: "Talk" }).click();
  await expect(page.getByRole("dialog", { name: "Talk to Invoice teammate" })).toBeVisible();
});
