import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** Whether a service lets itself be shown inside a page of Kago's: it does, it does not, or it could not be asked. */
export type FrameVerdict = "allowed" | "blocked" | "unknown";

/**
 * Where the question is never sent. A shortcut leads to a service on the home network, so private addresses are
 * exactly where it has to go; what is left out is what no shortcut means: this machine itself (to the browser,
 * `localhost` is another machine altogether), and the link-local range, where a cloud keeps the keys to itself.
 */
const neverAsked = new net.BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) neverAsked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 96], ["fe80::", 10], ["ff00::", 8]] as const) neverAsked.addSubnet(network, prefix, "ipv6");

/** Whether an address is one a service may be asked at. */
export function mayBeAsked(address: string): boolean {
  const family = net.isIP(address);
  return family !== 0 && !neverAsked.check(address, family === 6 ? "ipv6" : "ipv4");
}

const MAX_REDIRECTS = 4;
const HOP_TIMEOUT_MS = 4000;

type Headers = Record<string, string | string[] | undefined>;
export type ProbeOptions = { /** Which addresses may be asked; the tests ask this machine. */ allow?: (address: string) => boolean; timeoutMs?: number };

/** One request, of which only the status and the headers are taken: the answer itself is hung up on, unread. */
function ask(url: URL, allow: (address: string) => boolean, timeoutMs: number): Promise<{ status: number; headers: Headers }> {
  return new Promise((resolve, reject) => {
    // The connection's own lookup, so the address that was judged is the one connected to.
    const lookup = ((hostname: string, options: dns.LookupOptions, callback: (error: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void) => {
      dns.lookup(hostname, { ...options, all: true }, (error, answers) => {
        if (error) return callback(error);
        const found = answers.filter((entry) => allow(entry.address));
        if (found.length === 0) return callback(Object.assign(new Error(`${hostname} is not asked`), { code: "ENOTASKED" }));
        if (options.all) callback(null, found);
        else callback(null, found[0]!.address, found[0]!.family);
      });
    }) as net.LookupFunction;
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        agent: false,
        lookup,
        signal: AbortSignal.timeout(timeoutMs),
        // A service at home often signs its own certificate. Nothing is sent to it and nothing but its headers is
        // read, so whether the browser will trust it is left to the browser.
        rejectUnauthorized: false,
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Mozilla/5.0 (compatible; Kago)" }
      },
      (response) => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
        response.destroy();
      }
    );
    request.on("error", reject);
  });
}

const defaultPort = (protocol: string) => (protocol === "https:" ? "443" : "80");

/** Whether one source of a `frame-ancestors` list lets the page in. `self` is the origin of the service that sent the list. */
function sourceAllows(source: string, page: URL, self: URL): boolean {
  const lower = source.toLowerCase();
  if (lower === "'none'") return false;
  if (lower === "'self'") return page.origin === self.origin;
  if (lower === "*") return true;
  // A page reached over HTTPS is let in wherever the same page over HTTP would be.
  const schemeAllows = (scheme: string) => `${scheme}:` === page.protocol || (scheme === "http" && page.protocol === "https:");
  if (/^[a-z][a-z0-9+.-]*:$/.test(lower)) return schemeAllows(lower.slice(0, -1));
  const host = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9.-]+|\[[0-9a-f:.]+\]|\*)(?::(\d+|\*))?(?:\/.*)?$/.exec(lower);
  if (!host) return false;
  const [, scheme, wildcard, name, port] = host;
  if (!(scheme ? schemeAllows(scheme) : schemeAllows(self.protocol.slice(0, -1)))) return false;
  if (name !== "*" && !(wildcard ? page.hostname.endsWith(`.${name}`) : page.hostname === name)) return false;
  return port === "*" || (port ?? defaultPort(page.protocol)) === (page.port || defaultPort(page.protocol));
}

/**
 * What a service's headers say about being framed by a page at `pageOrigin`. It is read the way a browser reads
 * it: a `frame-ancestors` list in the Content-Security-Policy decides alone, and each policy that has one must
 * let the page in; only without any does X-Frame-Options count, and the form of it no browser honours any more
 * (`ALLOW-FROM`) counts for nothing.
 */
export function framingVerdict(headers: Headers, targetOrigin: string, pageOrigin: string): FrameVerdict {
  let page: URL;
  let self: URL;
  try {
    page = new URL(pageOrigin);
    self = new URL(targetOrigin);
  } catch {
    return "unknown";
  }
  const all = (value: string | string[] | undefined) => [value ?? []].flat().flatMap((item) => item.split(","));
  const lists = all(headers["content-security-policy"])
    .map((policy) => policy.split(";").map((directive) => directive.trim().split(/\s+/)).find(([name]) => name?.toLowerCase() === "frame-ancestors"))
    .filter((directive) => directive !== undefined);
  if (lists.length > 0) return lists.every(([, ...sources]) => sources.some((source) => sourceAllows(source, page, self))) ? "allowed" : "blocked";
  const options = all(headers["x-frame-options"]).map((value) => value.trim().toLowerCase());
  if (options.includes("deny")) return "blocked";
  if (options.includes("sameorigin")) return page.origin === self.origin ? "allowed" : "blocked";
  return "allowed";
}

/**
 * Asks a service, the way a browser about to frame it would, whether it lets itself be framed. A redirect is
 * followed a few times, since a service seldom lives at the very address it is known by, and it is the page at
 * the end whose answer counts. Nothing of the answer is kept but that verdict.
 *
 * The server asks from where it stands, which is not where the browser stands: a name may lead it elsewhere, or
 * nowhere. Then the verdict is `unknown`, and it is never more than a forecast.
 */
export async function probeFraming(address: string, pageOrigin: string, { allow = mayBeAsked, timeoutMs = HOP_TIMEOUT_MS }: ProbeOptions = {}): Promise<FrameVerdict> {
  try {
    let url = new URL(address);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
      url.username = "";
      url.password = "";
      // An address written out as numbers is never looked up, so it is judged here.
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(literal) !== 0 && !allow(literal)) return "unknown";
      const response = await ask(url, allow, timeoutMs);
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && typeof location === "string") {
        url = new URL(location, url);
        continue;
      }
      return framingVerdict(response.headers, url.origin, pageOrigin);
    }
  } catch {
    // Not reachable from here, or not an address: nothing is known.
  }
  return "unknown";
}

/** How many services one person may have asked in a minute; past it nothing more is asked, and nothing is known. */
const ASKS_PER_MINUTE = 30;
const REMEMBERED_MS = 60_000;
const MAX_REMEMBERED = 500;

/**
 * Asks services whether they may be framed, on behalf of the people signed in. Whoever may add a shortcut may
 * have the server knock on a door of the network it sits in, so each person gets only so many knocks, an answer
 * is remembered for a minute, and all that is ever told is one of three words.
 */
export class FrameProbe {
  private readonly answers = new Map<string, { verdict: Promise<FrameVerdict>; at: number }>();
  private readonly asked = new Map<string, { count: number; since: number }>();

  constructor(private readonly probe: (address: string, pageOrigin: string) => Promise<FrameVerdict> = probeFraming) {}

  ask(userId: string, address: string, pageOrigin: string): Promise<FrameVerdict> {
    const now = Date.now();
    const key = `${pageOrigin} ${address}`;
    const known = this.answers.get(key);
    if (known && now - known.at < REMEMBERED_MS) return known.verdict;
    let count = this.asked.get(userId);
    if (!count || now - count.since > 60_000) {
      if (this.asked.size >= MAX_REMEMBERED) this.asked.clear();
      count = { count: 0, since: now };
      this.asked.set(userId, count);
    }
    count.count += 1;
    if (count.count > ASKS_PER_MINUTE) return Promise.resolve("unknown");
    if (this.answers.size >= MAX_REMEMBERED) this.answers.clear();
    const verdict = this.probe(address, pageOrigin);
    this.answers.set(key, { verdict, at: now });
    return verdict;
  }
}
