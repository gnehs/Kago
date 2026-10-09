import dns from "node:dns";
import https from "node:https";
import net from "node:net";

/**
 * Addresses that are not out on the internet: this machine, the network it sits on, and the ranges set aside for
 * anything else. An IPv4 address written as an IPv6 one (`::ffff:10.0.0.1`) is held to the IPv4 rules, which is how
 * the list reads it; the other ways of carrying IPv4 inside IPv6 (NAT64, 6to4) are refused whole, as nothing Kago
 * fetches from lives there.
 *
 * 198.18.0.0/15 is left out on purpose. It is set aside for testing network gear, and it is where a proxy that
 * answers DNS itself (Surge, Clash or sing-box in "fake-IP" mode, on the machine or on its router) puts every name
 * there is: refusing it would cut the internet off for everyone behind one. What is asked is still held to the
 * hosts allowed, and to the certificates only they can show.
 */
const notPublic = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) notPublic.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
] as const) notPublic.addSubnet(network, prefix, "ipv6");

/** Whether an address is one out on the internet. Anything that is not plainly an address is not. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !notPublic.check(address, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Looks a name up as usual and keeps only the addresses that are public, refusing the name when none is. It is
 * the connection's own lookup, so what was checked is what gets connected to: a name cannot answer one way to be
 * checked and another way to be used.
 */
const publicLookup = ((hostname: string, options: dns.LookupOptions, callback: (error: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void) => {
  dns.lookup(hostname, { ...options, all: true }, (error, answers) => {
    if (error) return callback(error);
    const found = answers.filter((entry) => isPublicAddress(entry.address));
    if (found.length === 0) return callback(Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: "ENOTPUBLIC" }));
    if (options.all) callback(null, found);
    else callback(null, found[0]!.address, found[0]!.family);
  });
}) as net.LookupFunction;

/** A few connections, kept open between the pictures of one search. */
const agent = new https.Agent({ keepAlive: true, maxSockets: 4, timeout: 15_000 });

export type PublicFetchOptions = {
  /** The only hosts that may be asked. */
  hosts: readonly string[];
  /** The answer is dropped once it is longer than this. */
  maxBytes: number;
  timeoutMs?: number;
};

export type PublicFetch = (url: string, options: PublicFetchOptions) => Promise<Buffer>;

/**
 * Fetches something from one of a fixed set of hosts on the internet, and from nowhere else: over HTTPS, at the
 * default port, to a public address, without following a redirect and without reading more than it was told to.
 * Whatever comes back is only bytes; what they are is for the caller to find out.
 */
export const fetchPublic: PublicFetch = (address, { hosts, maxBytes, timeoutMs = 10_000 }) =>
  new Promise<Buffer>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return reject(new Error("Not a valid address"));
    }
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || net.isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 || !hosts.includes(url.hostname)) {
      return reject(new Error(`${url.hostname} is not a host Kago fetches from`));
    }
    const request = https.get(
      url,
      // Sent as it is stored, so that what is counted is what arrives.
      { agent, lookup: publicLookup, signal: AbortSignal.timeout(timeoutMs), headers: { accept: "*/*", "accept-encoding": "identity", "user-agent": "Kago" } },
      (response) => {
        const fail = (message: string) => {
          response.destroy();
          reject(new Error(message));
        };
        // A redirect is an answer like any other failure: it is never followed to wherever it points.
        if (response.statusCode !== 200) return fail(`${url.hostname} answered ${response.statusCode}`);
        if ((response.headers["content-encoding"] ?? "identity") !== "identity") return fail("The answer is compressed");
        if (Number(response.headers["content-length"] ?? 0) > maxBytes) return fail("The answer is too large");
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) return fail("The answer is too large");
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      }
    );
    request.on("error", reject);
  });
