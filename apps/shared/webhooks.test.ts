import assert from "node:assert/strict";
import { test } from "node:test";
import { requireHookAddress } from "./webhooks";

test("notices go only to Mission Control's hooks address", () => {
  const hooks = "http://localhost:8787";
  assert.equal(requireHookAddress("http://localhost:8787/hooks/lmail", hooks), "http://localhost:8787/hooks/lmail");
  for (const inside of ["http://169.254.169.254/latest/meta-data", "http://localhost:5452/", "http://127.0.0.1:8787/hooks/lmail", "file:///etc/passwd"]) {
    assert.throws(() => requireHookAddress(inside, hooks), /Notices go only to/, inside);
  }
});
