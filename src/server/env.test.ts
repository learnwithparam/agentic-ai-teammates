import assert from "node:assert/strict";
import { test } from "node:test";
import { MissingSettings, requireSettings, setting } from "./env";

test("a missing setting stops with its name and where to get it", () => {
  assert.throws(() => setting("OPENROUTER_API_KEY", {}), (error: unknown) => {
    if (!(error instanceof MissingSettings)) return false;
    assert.match(error.message, /OPENROUTER_API_KEY: Your OpenRouter key/);
    return true;
  });
});

test("an empty value counts as missing", () => {
  assert.throws(() => setting("DATABASE_URL", { DATABASE_URL: "" }), MissingSettings);
});

test("requireSettings lists every missing setting at once", () => {
  assert.throws(
    () => requireSettings(["DATABASE_URL", "OPENROUTER_API_KEY", "APP_URL"], { APP_URL: "http://localhost:8790" }),
    (error: unknown) => error instanceof MissingSettings && error.missing.join() === "DATABASE_URL,OPENROUTER_API_KEY",
  );
});
