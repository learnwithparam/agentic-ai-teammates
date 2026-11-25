import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

// Reads one news article as plain text. The gateway runs this on a URL a source gave, so it
// reaches only the public internet. Every connection is checked, so neither a redirect nor a
// DNS answer can point it at the gateway's own machine or private network.

export const MAX_ARTICLE_CHARS = 8000;
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 20_000;

export class ArticleError extends Error {}

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv4");
}
// IPv6 is public only inside 2000::/3, the global addresses. Inside it, 6to4 (2002::/16), Teredo
// (2001::/32) and the documentation range carry or stand for other addresses, so they are refused too.
// Everything outside it, such as NAT64, IPv4-compatible and site-local forms, is refused as well.
const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");
const TUNNELLED_IPV6 = new BlockList();
for (const [network, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16]] as const) {
  TUNNELLED_IPV6.addSubnet(network, prefix, "ipv6");
}

// An IPv4 address written as IPv6, such as ::ffff:127.0.0.1 or ::ffff:7f00:1, as plain IPv4.
// A BlockList range of ::ffff:0:0/96 would also match every plain IPv4 address, so it is not used.
function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (!match) return null;
  if (match[1]) return match[1];
  const high = parseInt(match[2], 16);
  const low = parseInt(match[3], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !PRIVATE.check(address, "ipv4");
  const ipv4 = mappedIpv4(new URL(`http://[${address}]`).hostname.slice(1, -1));
  if (ipv4) return isPublicAddress(ipv4);
  return GLOBAL_IPV6.check(address, "ipv6") && !TUNNELLED_IPV6.check(address, "ipv6");
}

// The DNS lookup each connection uses. It fails when any address for the name is not public.
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    const refused = addresses.find((entry) => !isPublicAddress(entry.address));
    if (refused || addresses.length === 0) return callback(new ArticleError(`${hostname} is not on the public internet.`), "", 0);
    if (options.all) return (callback as unknown as (error: null, all: LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

function checkUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ArticleError("Only web pages can be read.");
  if (url.username || url.password) throw new ArticleError("A link with a login in it is not read.");
  // A bare IP address skips the lookup, so it is checked here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new ArticleError(`${host} is not on the public internet.`);
  return url;
}

// The whole read, every redirect included, must finish by the deadline. A quiet connection is
// also dropped after TIMEOUT_MS, so a slow page cannot hold the reader open.
function getOnce(url: URL, deadline: AbortSignal): Promise<{ status: number; location: string | null; contentType: string; body: string }> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    if (deadline.aborted) return reject(new ArticleError("The page took too long to answer."));
    deadline.addEventListener("abort", () => reject(new ArticleError("The page took too long to answer.")), { once: true });
    const request = client.get(
      url,
      {
        lookup: publicLookup,
        signal: deadline,
        timeout: TIMEOUT_MS,
        headers: { "User-Agent": "agentic-ai-teammates news reader", Accept: "text/html", "Accept-Encoding": "identity" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        const contentType = String(response.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          response.resume();
          return resolve({ status, location, contentType, body: "" });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) request.destroy(new ArticleError("The page is too large to read."));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, location, contentType, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new ArticleError("The page took too long to answer.")));
    request.on("error", reject);
  });
}

async function fetchPage(raw: string): Promise<{ url: string; html: string }> {
  let url = checkUrl(raw);
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const page = await getOnce(url, deadline);
    if (page.status >= 300 && page.status < 400 && page.location) {
      url = checkUrl(new URL(page.location, url).toString());
      continue;
    }
    if (page.status !== 200) throw new ArticleError(`${url.host} answered ${page.status}.`);
    if (!page.contentType.includes("html")) throw new ArticleError(`${url.host} sent ${page.contentType || "no content type"}, not a web page.`);
    return { url: url.toString(), html: page.body };
  }
  throw new ArticleError("The page redirected too many times.");
}

// The readable text of a page, the way a browser's reader view finds it.
export function articleText(html: string): { title: string | null; text: string } {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = (article?.textContent ?? "").replace(/\s+/g, " ").trim();
  return { title: article?.title ?? null, text: text.slice(0, MAX_ARTICLE_CHARS) };
}

export async function readArticle(url: string): Promise<{ url: string; title: string | null; text: string }> {
  try {
    const page = await fetchPage(url);
    return { url: page.url, ...articleText(page.html) };
  } catch (error) {
    if (error instanceof ArticleError) throw error;
    throw new ArticleError(`The page could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}
