import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as oidc from "openid-client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { discover, personFromClaims, readCookie, samePagePath, verifyAccessToken } from "./auth";

// Tokens signed here with a key made for the test, shaped like Keycloak's.
const ISSUER = "http://localhost:8190/realms/teammates";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "test" }] });

async function token(claims: Record<string, unknown>, audience = "mission-control-api", issuer = ISSUER) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("user-ravi")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

const ravi = {
  email: "ravi@bramble.example",
  name: "Ravi Menon",
  organization: ["bramble"],
  realm_access: { roles: ["approver", "default-roles-teammates"] },
  approval_limit: 5000,
};

test("a person is read from the signed token: company, role and limit", async () => {
  const person = await verifyAccessToken(await token(ravi), keys, ISSUER, "mission-control-api");
  assert.deepEqual(person, {
    subject: "user-ravi",
    email: "ravi@bramble.example",
    name: "Ravi Menon",
    company: "bramble",
    roles: ["approver"],
    approvalLimit: 5000,
  });
});

test("a token for another audience or issuer is refused", async () => {
  await assert.rejects(verifyAccessToken(await token(ravi, "account"), keys, ISSUER, "mission-control-api"));
  await assert.rejects(verifyAccessToken(await token(ravi, "mission-control-api", "http://evil.example"), keys, ISSUER, "mission-control-api"));
});

test("a token signed by another key is refused", async () => {
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT(ravi)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(ISSUER)
    .setAudience("mission-control-api")
    .setExpirationTime("5m")
    .sign(other.privateKey);
  await assert.rejects(verifyAccessToken(forged, keys, ISSUER, "mission-control-api"));
});

test("an account with no company is refused, and a limit without the approver role is ignored", () => {
  assert.throws(() => personFromClaims({ sub: "x", realm_access: { roles: ["admin"] } }), /not in a company/);
  const viewer = personFromClaims({ sub: "mei", organization: ["bramble"], approval_limit: 99999 });
  assert.deepEqual(viewer.roles, []);
  assert.equal(viewer.approvalLimit, undefined);
});

test("the session cookie is read by its exact name", () => {
  assert.equal(readCookie("lmail_session=abc; mc_session=xyz", "mc_session"), "xyz");
  assert.equal(readCookie("mc_session_old=1", "mc_session"), undefined);
});

test("after sign-in a person only ever lands on a page of this app", () => {
  const app = "http://localhost:8790";
  assert.equal(samePagePath("/board?teammate=invoice#run", app), "/board?teammate=invoice#run");
  for (const outside of ["//evil.example", "/\\evil.example", "/\\/evil.example", "https://evil.example", "/\tevil", undefined, 42]) {
    assert.equal(samePagePath(outside, app), "/", String(outside));
  }
});

test("an app waits for a Keycloak that is not ready yet, and gives up after its tries", async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    if (calls <= 2) {
      response.writeHead(503).end();
      return;
    }
    const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}/realms/teammates`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/certs`, token_endpoint: `${issuer}/token` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const issuer = new URL(`http://127.0.0.1:${port}/realms/teammates`);
  const options = { execute: [oidc.allowInsecureRequests] };
  try {
    const config = await discover(issuer, "web", "secret", options, { tries: 5, delayMs: 10 });
    assert.equal(config.serverMetadata().issuer, issuer.href);
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(discover(issuer, "web", "secret", options, { tries: 2, delayMs: 10 }));
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});
