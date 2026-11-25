import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { browserAddresses, KEYCLOAK_PORT, WEB_PORT, WORLD } from "./addresses.ts";

test("without a public domain every address is a localhost port", () => {
  assert.deepEqual(browserAddresses(), {
    APP_URL: "http://localhost:8790",
    KEYCLOAK_HOSTNAME: "http://localhost:8190",
    OIDC_ISSUER: "http://localhost:8190/realms/teammates",
    LMAIL_URL: "http://localhost:8801",
    LDRIVE_URL: "http://localhost:8802",
    QUIRKBOOKS_URL: "http://localhost:8803",
  });
});

test("with a public domain every address is an https name", () => {
  assert.deepEqual(browserAddresses("Teammates.Example.com "), {
    APP_URL: "https://teammates.example.com",
    KEYCLOAK_HOSTNAME: "https://auth.teammates.example.com",
    OIDC_ISSUER: "https://auth.teammates.example.com/realms/teammates",
    LMAIL_URL: "https://mail.teammates.example.com",
    LDRIVE_URL: "https://drive.teammates.example.com",
    QUIRKBOOKS_URL: "https://books.teammates.example.com",
  });
});

test("a public domain with a scheme, a path or a port is refused", () => {
  for (const bad of ["https://teammates.example.com", "teammates.example.com/app", "teammates.example.com:443", "localhost"]) {
    assert.throws(() => browserAddresses(bad), /bare host name/);
  }
});

test("the Caddyfile sends each public name to the port its local address uses", () => {
  const caddy = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
  const routes = new Map([...caddy.matchAll(/^(\S*)\{\$PUBLIC_DOMAIN\} \{\n\treverse_proxy localhost:(\d+)\n\}/gm)]
    .map(([, name, port]) => [name, Number(port)]));
  const expected = new Map<string, number>([["", WEB_PORT], ["auth.", KEYCLOAK_PORT], ...WORLD.map((app) => [`${app.subdomain}.`, app.port] as [string, number])]);
  assert.deepEqual(routes, expected);
});

test("Keycloak takes its hostname from the setting, with the laptop address when it is missing", () => {
  const infra = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");
  assert.match(infra, /--hostname=\$\{KEYCLOAK_HOSTNAME:-http:\/\/localhost:8190\}/);
});
