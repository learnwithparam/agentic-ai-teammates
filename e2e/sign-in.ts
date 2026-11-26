import { expect, type Page } from "@playwright/test";
import { setting } from "../src/server/env";

export const PEOPLE = {
  ada: "ada@bramble.example",
  ravi: "ravi@bramble.example",
  mei: "mei@bramble.example",
} as const;

// Opens a page signed out, so Mission Control sends the browser to Keycloak. The test then types
// the person's own email and password into Keycloak's form, the way a person signs in.
export async function signIn(page: Page, who: keyof typeof PEOPLE, path = "/") {
  await page.goto(path);
  // The realm asks for the email first and the password on the next screen.
  await page.locator("#username").fill(PEOPLE[who]);
  await page.locator("#kc-login").click();
  await page.locator("#password").fill(setting("SEED_USER_PASSWORD"));
  await page.locator("#kc-login").click();
  // The page title shows at every width. On a phone the sidebar, and its name, are folded away.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}
