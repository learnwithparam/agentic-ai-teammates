// The addresses people open in a browser: the board, the sign-in and the three apps.
// On a laptop each is a localhost port. With PUBLIC_DOMAIN set, each is an https name that
// deploy/Caddyfile sends to the same port. One function decides both, so the two never drift.

export const WEB_PORT = 8790; // 8787 belongs to the agentic-ai-buildcamp; both workshops can run at once.
export const KEYCLOAK_PORT = 8190;
export const WORLD = [
  { id: "lmail", prefix: "LMAIL", name: "LMail", port: 8801, subdomain: "mail" },
  { id: "ldrive", prefix: "LDRIVE", name: "LDrive", port: 8802, subdomain: "drive" },
  { id: "quirkbooks", prefix: "QUIRKBOOKS", name: "QuirkBooks", port: 8803, subdomain: "books" },
] as const;
export const REALM = "teammates";

// A bare host name such as teammates.example.com: letters, digits, dots and dashes only.
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function browserAddresses(publicDomain = ""): Record<string, string> {
  const domain = publicDomain.trim().toLowerCase();
  if (domain && !HOST.test(domain)) {
    throw new Error(`PUBLIC_DOMAIN must be a bare host name such as teammates.example.com, not "${publicDomain}".`);
  }
  const at = (subdomain: string, port: number) =>
    domain ? `https://${subdomain ? `${subdomain}.` : ""}${domain}` : `http://localhost:${port}`;
  const keycloak = at("auth", KEYCLOAK_PORT);
  const addresses: Record<string, string> = {
    APP_URL: at("", WEB_PORT),
    KEYCLOAK_HOSTNAME: keycloak,
    OIDC_ISSUER: `${keycloak}/realms/${REALM}`,
  };
  for (const app of WORLD) addresses[`${app.prefix}_URL`] = at(app.subdomain, app.port);
  return addresses;
}
