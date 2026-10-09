import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildApp } from "../dist/app.js";
import { FrameProbe, framingVerdict, mayBeAsked, probeFraming } from "../src/lib/frame-probe.ts";
import { readIcon, ICON_MAX_BYTES } from "../src/lib/icon-image.ts";
import { fetchPublic, isPublicAddress } from "../src/lib/public-fetch.ts";
import { sanitizeSvg } from "../src/lib/svg-sanitize.ts";
import { IconLibraryService } from "../src/services/icon-library.service.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const base64 = (data) => Buffer.from(data).toString("base64");

test("only addresses out on the internet count as public", () => {
  for (const address of [
    "127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "::127.0.0.1", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::", "ff02::1", "not-an-address", ""
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  // 198.18.0.0/15 is where a proxy that answers DNS itself puts every name, so it is not refused.
  for (const address of ["1.1.1.1", "151.101.1.229", "172.32.0.1", "198.18.1.42", "2606:4700::1111", "2a04:4e42::485"]) assert.equal(isPublicAddress(address), true, address);
});

test("nothing is fetched from anywhere but the hosts allowed, over HTTPS, at a public address", async () => {
  const options = { hosts: ["cdn.example.test", "localhost"], maxBytes: 1024, timeoutMs: 2000 };
  for (const address of [
    "http://cdn.example.test/icon.svg",
    "https://elsewhere.example.test/icon.svg",
    "https://cdn.example.test.elsewhere.example.test/icon.svg",
    "https://cdn.example.test:8443/icon.svg",
    "https://user:secret@cdn.example.test/icon.svg",
    "https://127.0.0.1/icon.svg",
    "https://[::1]/icon.svg",
    "file:///etc/passwd",
    "not an address"
  ]) {
    await assert.rejects(fetchPublic(address, options), address);
  }
  // A host that is allowed, but whose name leads back to this machine, is refused as it is looked up.
  await assert.rejects(fetchPublic("https://localhost/icon.svg", options), (error) => error.code === "ENOTPUBLIC");
});

test("an SVG is rewritten down to what draws", () => {
  const clean = sanitizeSvg(`<?xml version="1.0"?>
    <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:evil="http://evil.example" viewBox="0 0 10 10" onload="alert(1)" evil:thing="1">
      <!-- a comment -->
      <script>alert(1)</script>
      <script href="https://evil.example/x.js"/>
      <foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(2)"/></body></foreignObject>
      <defs><linearGradient id="a"><stop offset="0" style="stop-color:#aa5cc3"/></linearGradient></defs>
      <style>.a{fill:red}</style>
      <style>@import url(https://evil.example/a.css);</style>
      <a href="javascript:alert(3)"><path d="M9 9"/></a>
      <path id="p" d="M0 0h10" fill="url(#a)" onclick="alert(4)" style="stroke:url(https://evil.example/x)"/>
      <path d="M1 1" style="fill:url(#a)" filter="url(https://evil.example/f.svg#f)"/>
      <use href="#p"/><use xlink:href="https://evil.example/sprite.svg#x"/><use href="java&#x73;cript:alert(5)"/>
      <image href="https://evil.example/track.png" width="1" height="1"/>
      <image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>
      <image href="data:image/svg+xml;base64,PHN2Zy8+" width="1" height="1"/>
      <animate attributeName="href" to="javascript:alert(6)"/>
      <text>a &lt; b &amp; c<tspan>d</tspan></text>
    </svg>`);
  assert.ok(clean);
  for (const gone of ["script", "onload", "onclick", "onerror", "foreignObject", "evil", "javascript", "@import", "animate", "DOCTYPE", "svg+xml", "comment", "<a "]) {
    assert.equal(clean.includes(gone), false, `${gone} is still there: ${clean}`);
  }
  for (const kept of ['<svg xmlns="http://www.w3.org/2000/svg"', 'viewBox="0 0 10 10"', 'fill="url(#a)"', 'style="fill:url(#a)"', "<style>.a{fill:red}</style>", '<use href="#p"/>', "data:image/png;base64,iVBORw0KGgo=", "a &lt; b &amp; c<tspan>d</tspan>", "stop-color:#aa5cc3"]) {
    assert.ok(clean.includes(kept), `${kept} is missing: ${clean}`);
  }
  // Written out again, it is the same.
  assert.equal(sanitizeSvg(clean), clean);
});

test("an SVG that cannot be read with certainty is not an icon", () => {
  const bomb = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${Array.from({ length: 24 }, (_, level) => `<g id="l${level}"><use href="#l${level + 1}"/><use href="#l${level + 1}"/></g>`).join("")}<path id="l24" d="M0 0"/></defs><use href="#l0"/></svg>`;
  for (const [why, source] of [
    ["entities of its own", `<!DOCTYPE svg [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&lol2;</text></svg>`],
    ["a file read through an entity", `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>`],
    ["an entity nothing defines", `<svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>`],
    ["an element used without end", bomb],
    ["an element that uses itself", `<svg xmlns="http://www.w3.org/2000/svg"><g id="a"><use href="#a"/></g></svg>`],
    ["not an SVG", `<html><body><script>alert(1)</script></body></html>`],
    ["a second document after the first", `<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>`],
    ["tags that do not match", `<svg xmlns="http://www.w3.org/2000/svg"><g></svg>`],
    ["an attribute without quotes", `<svg xmlns="http://www.w3.org/2000/svg" width=10/>`],
    ["a tag that never ends", `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"`],
    ["nesting without end", `${"<svg>".repeat(200)}${"</svg>".repeat(200)}`],
    ["plain text", "just some words"],
    ["nothing", ""]
  ]) {
    assert.equal(sanitizeSvg(source), null, why);
  }
});

test("a picture is told by its own bytes", () => {
  assert.equal(readIcon(PNG).type, "png");
  assert.equal(readIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).type, "jpg");
  assert.equal(readIcon(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")).type, "webp");
  assert.equal(readIcon(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>`)).type, "svg");
  for (const data of [Buffer.from("<html><script>alert(1)</script></html>"), Buffer.from("GIF89a"), Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x73, 0x00]), Buffer.alloc(0)]) {
    assert.throws(() => readIcon(data), (error) => error.code === "ICON_UNSUPPORTED");
  }
  assert.throws(() => readIcon(Buffer.concat([PNG, Buffer.alloc(ICON_MAX_BYTES)])), (error) => error.code === "ICON_TOO_LARGE");
});

test("library icons come only from the libraries' own lists, and are cleaned like any other picture", async (t) => {
  const appDataDir = await mkdtemp(path.join(tmpdir(), "kago-icon-library."));
  t.after(() => rm(appDataDir, { recursive: true, force: true }));
  const asked = [];
  const answers = {
    "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/metadata.json": JSON.stringify({
      jellyfin: { base: "svg", aliases: ["Media System"] },
      "jellyfin-vue": { base: "svg", aliases: [] },
      "home-assistant": { base: "png", aliases: ["hass"] },
      liar: { base: "png", aliases: [] },
      "../../../etc/passwd": { base: "svg", aliases: [] },
      "Bad Name": { base: "svg", aliases: [] },
      "no-format": { base: "exe", aliases: [] }
    }),
    "https://cdn.jsdelivr.net/gh/selfhst/icons/index.json": JSON.stringify([
      { Name: "Jellyfin", Reference: "jellyfin", SVG: "Yes", PNG: "Yes", Tags: "" },
      { Name: "Immich", Reference: "immich", SVG: "No", PNG: "Yes", Tags: "photos, gallery" },
      { Name: "Sneaky", Reference: "x/../../y", SVG: "Yes", PNG: "Yes", Tags: "" }
    ]),
    "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/jellyfin.svg": `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path d="M0 0"/></svg>`,
    "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/liar.png": "<html><script>alert(1)</script></html>",
    "https://cdn.jsdelivr.net/gh/selfhst/icons/png/immich.png": PNG
  };
  const fetch = async (url, options) => {
    asked.push(url);
    assert.deepEqual(options.hosts, ["cdn.jsdelivr.net"]);
    assert.ok(options.maxBytes > 0);
    if (!(url in answers)) throw new Error(`unexpected request for ${url}`);
    return Buffer.from(answers[url]);
  };
  const library = new IconLibraryService(appDataDir, fetch);

  const found = await library.search("Jellyfin");
  assert.equal(found.available, true);
  // The name itself comes first, once, from the library that is preferred.
  assert.deepEqual(found.items.map((item) => [item.source, item.name, item.exact]), [["dashboard-icons", "jellyfin", true], ["dashboard-icons", "jellyfin-vue", false]]);
  assert.deepEqual((await library.search("hass")).items.map((item) => item.name), ["home-assistant"]);
  assert.deepEqual((await library.search("Home Assistant")).items.map((item) => [item.name, item.exact]), [["home-assistant", true]]);
  assert.deepEqual((await library.search("My Immich")).items.map((item) => [item.source, item.name]), [["selfhst", "immich"]]);
  assert.deepEqual((await library.search("j")).items, []);
  assert.deepEqual((await library.search("影音")).items, []);
  // Names that could not be part of an address were never taken into the list.
  assert.deepEqual((await library.search("passwd")).items, []);
  assert.deepEqual((await library.search("sneaky")).items, []);
  assert.deepEqual((await library.search("bad name")).items, []);

  const icon = await library.icon("dashboard-icons", "jellyfin");
  assert.equal(icon.type, "svg");
  const kept = await readFile(icon.file, "utf8");
  assert.equal(kept.includes("script"), false);
  assert.equal(kept.includes("onload"), false);
  assert.ok(icon.file.startsWith(path.join(appDataDir, "app-icons", "library") + path.sep));
  assert.equal((await library.icon("selfhst", "immich")).type, "png");

  // Asked for again, it is read from disk.
  const before = asked.length;
  await library.icon("dashboard-icons", "jellyfin");
  assert.equal(asked.length, before);

  // What no list names is not asked for at all, whatever it is called.
  for (const [source, name] of [["dashboard-icons", "nextcloud"], ["dashboard-icons", "../../../etc/passwd"], ["dashboard-icons", "jellyfin/../../x"], ["selfhst", "x/../../y"], ["https://evil.example", "jellyfin"], ["", ""]]) {
    await assert.rejects(library.icon(source, name), (error) => error.code === "ICON_NOT_FOUND", `${source} ${name}`);
  }
  assert.equal(asked.length, before);
  // A library that sends something other than the picture it listed is not believed.
  await assert.rejects(library.icon("dashboard-icons", "liar"), (error) => error.code === "ICON_FETCH_FAILED");
  for (const url of asked) assert.ok(url in answers, url);
  assert.deepEqual((await readdir(path.join(appDataDir, "app-icons", "library"))).sort(), ["dashboard-icons.jellyfin.svg", "selfhst.immich.png"]);

  // With no library in reach there is nothing to suggest, and that is all that happens.
  const offline = new IconLibraryService(await mkdtemp(path.join(appDataDir, "offline.")), async () => {
    throw new Error("no network");
  });
  assert.deepEqual(await offline.search("jellyfin"), { available: false, items: [] });
  await assert.rejects(offline.icon("dashboard-icons", "jellyfin"), (error) => error.code === "ICON_NOT_FOUND");
});

test("a service's headers are read the way a browser frames by them", () => {
  const kago = "https://kago.example.test";
  const service = "https://jellyfin.example.test";
  const verdict = (headers, page = kago, target = service) => framingVerdict(headers, target, page);
  assert.equal(verdict({}), "allowed");
  assert.equal(verdict({ "x-frame-options": "DENY" }), "blocked");
  assert.equal(verdict({ "x-frame-options": "SAMEORIGIN" }), "blocked");
  assert.equal(verdict({ "x-frame-options": "sameorigin" }, service), "allowed");
  assert.equal(verdict({ "x-frame-options": "SAMEORIGIN, DENY" }, service), "blocked");
  // No browser honours this form any more, so it holds nothing back.
  assert.equal(verdict({ "x-frame-options": "ALLOW-FROM https://elsewhere.example.test" }), "allowed");
  assert.equal(verdict({ "content-security-policy": "default-src 'self'" }), "allowed");
  assert.equal(verdict({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }), "blocked");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors 'self'" }), "blocked");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors 'self'" }, service), "allowed");
  assert.equal(verdict({ "content-security-policy": "FRAME-ANCESTORS *" }), "allowed");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors https:" }), "allowed");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors https:" }, "http://kago.example.test"), "blocked");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors 'self' https://kago.example.test" }), "allowed");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors https://*.example.test" }), "allowed");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors https://*.example.test" }, "https://example.test"), "blocked");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors kago.example.test" }), "allowed");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors https://kago.example.test:8443" }), "blocked");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors https://kago.example.test:8443" }, "https://kago.example.test:8443"), "allowed");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors https://kago.example.test.evil.example" }), "blocked");
  // With a list of ancestors the older header is not looked at, and every policy that has a list must agree.
  assert.equal(verdict({ "content-security-policy": "frame-ancestors *", "x-frame-options": "DENY" }), "allowed");
  assert.equal(verdict({ "content-security-policy": ["frame-ancestors *", "frame-ancestors 'none'"] }), "blocked");
  assert.equal(verdict({ "content-security-policy": "frame-ancestors *, frame-ancestors 'none'" }), "blocked");
  // A policy that only reports holds nothing back.
  assert.equal(verdict({ "content-security-policy-report-only": "frame-ancestors 'none'" }), "allowed");
  assert.equal(verdict({ "x-frame-options": "DENY" }, "not an origin"), "unknown");
});

test("a service is asked whether it may be framed, and nothing else", async (t) => {
  const seen = [];
  const serve = (handler) =>
    new Promise((resolve) => {
      const server = http.createServer((request, response) => {
        seen.push(`${request.method} ${request.headers.host}${request.url}`);
        handler(request, response);
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
      t.after(() => server.close());
    });
  const address = (server, pathName = "/") => `http://127.0.0.1:${server.address().port}${pathName}`;
  const refusing = await serve((request, response) => response.writeHead(200, { "x-frame-options": "DENY" }).end("secret body"));
  const open = await serve((request, response) => response.writeHead(200).end("open"));
  const listing = await serve((request, response) => response.writeHead(403, { "content-security-policy": "frame-ancestors https://kago.example.test" }).end());
  const redirecting = await serve((request, response) => {
    if (request.url === "/") response.writeHead(302, { location: "/web/" }).end();
    else if (request.url === "/web/") response.writeHead(307, { location: address(refusing, "/login") }).end();
    else if (request.url === "/loop") response.writeHead(302, { location: "/loop" }).end();
    else if (request.url === "/away") response.writeHead(302, { location: "file:///etc/passwd" }).end();
    // Never answered: the question is given up on.
    else if (request.url === "/slow") request.resume();
  });
  const kago = "https://kago.example.test";
  const here = { allow: () => true, timeoutMs: 300 };

  assert.equal(await probeFraming(address(refusing), kago, here), "blocked");
  assert.equal(await probeFraming(address(open), kago, here), "allowed");
  // Whatever the page at the address turns out to be, its headers still say who may frame it.
  assert.equal(await probeFraming(address(listing), kago, here), "allowed");
  assert.equal(await probeFraming(address(listing), "https://elsewhere.example.test", here), "blocked");
  // It is the page a redirect ends at whose answer counts.
  seen.length = 0;
  assert.equal(await probeFraming(address(redirecting), kago, here), "blocked");
  assert.deepEqual(seen.map((line) => line.split(" ")[0]), ["GET", "GET", "GET"]);
  assert.ok(seen[2].endsWith("/login"));
  for (const pathName of ["/loop", "/away", "/slow"]) assert.equal(await probeFraming(address(redirecting, pathName), kago, here), "unknown", pathName);
  assert.equal(await probeFraming("http://127.0.0.1:9/", kago, here), "unknown");

  // Left to itself it never asks this machine, nor where a cloud keeps its keys, whether named in numbers, by name or by a redirect.
  for (const address of ["127.0.0.1", "127.9.9.9", "::1", "0.0.0.0", "169.254.169.254", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "224.0.0.1", "nonsense"]) assert.equal(mayBeAsked(address), false, address);
  for (const address of ["192.168.1.10", "10.0.0.5", "172.16.3.4", "100.64.0.9", "fd12::1", "1.1.1.1", "198.18.1.42"]) assert.equal(mayBeAsked(address), true, address);
  seen.length = 0;
  for (const target of [address(refusing), `http://localhost:${refusing.address().port}/`, `http://[::1]:${refusing.address().port}/`, "http://169.254.169.254/latest/meta-data/", "ftp://127.0.0.1/", "not an address"]) {
    assert.equal(await probeFraming(target, kago, { timeoutMs: 300 }), "unknown", target);
  }
  const outward = await serve((request, response) => response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end());
  assert.equal(await probeFraming(address(outward), kago, { allow: (ip) => ip === "127.0.0.1" && seen.length === 0, timeoutMs: 300 }), "unknown");
  assert.deepEqual(seen.length, 1);

  // Each person gets only so many questions a minute; the same one asked again is not asked of the service again.
  let asked = 0;
  const probe = new FrameProbe(async () => {
    asked += 1;
    return "blocked";
  });
  assert.equal(await probe.ask("alice", "http://nas.local/", kago), "blocked");
  assert.equal(await probe.ask("bob", "http://nas.local/", kago), "blocked");
  assert.equal(asked, 1);
  const answers = await Promise.all(Array.from({ length: 40 }, (_, index) => probe.ask("alice", `http://nas.local:${8000 + index}/`, kago)));
  assert.equal(answers.filter((answer) => answer === "blocked").length, 29);
  assert.equal(answers.filter((answer) => answer === "unknown").length, 11);
  assert.equal(asked, 30);
  assert.equal(await probe.ask("bob", "http://nas.local:9999/", kago), "blocked");
});

test("a shortcut is its maker's own unless an administrator shares it", async () => {
  const fixture = await createFixture();
  const app = await buildApp({ port: 0, dataDir: fixture.dataDir, appDataDir: fixture.appDataDir, sessionSecret: "external-apps-test-session-secret", nodeEnv: "test" });
  const admin = client(app);
  const alice = client(app);
  const bob = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" })).statusCode, 200);
    for (const [who, name] of [[alice, "alice"], [bob, "bob"]]) {
      assert.equal((await admin.post("/api/users", { email: `${name}@example.test`, password: `fake-${name}-password-123`, displayName: name, role: "USER" })).statusCode, 200);
      assert.equal((await who.post("/api/auth/login", { email: `${name}@example.test`, password: `fake-${name}-password-123` })).statusCode, 200);
    }
    const names = async (who) => (await who.get("/api/external-apps")).json.map((item) => item.name);

    // Nothing of this is there for someone who is not signed in.
    const stranger = client(app);
    assert.equal((await stranger.get("/api/external-apps")).statusCode, 401);
    assert.equal((await stranger.post("/api/external-apps", { name: "X", url: "http://nas.local" })).statusCode, 401);
    assert.equal((await stranger.get("/api/app-icons?q=jellyfin")).statusCode, 401);
    assert.equal((await stranger.get("/api/app-icons/dashboard-icons/jellyfin")).statusCode, 401);
    assert.equal((await stranger.post("/api/external-apps/probe", { url: "http://nas.local:8096" })).statusCode, 401);
    // Asking whether a service may be framed takes a web address, and this machine is never the one asked.
    assert.equal((await alice.post("/api/external-apps/probe", { url: "file:///etc/passwd" })).statusCode, 400);
    assert.equal((await alice.post("/api/external-apps/probe", { url: "http://user:secret@nas.local" })).statusCode, 400);
    assert.deepEqual((await alice.post("/api/external-apps/probe", { url: "http://127.0.0.1:1/" })).json, { verdict: "unknown" });
    assert.deepEqual((await alice.post("/api/external-apps/probe", { url: "http://169.254.169.254/latest/meta-data/" })).json, { verdict: "unknown" });

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><path d="M0 0h4"/></svg>`;
    const mine = await alice.post("/api/external-apps", { name: "Jellyfin", url: "http://nas.local:8096/web/", icon: { kind: "upload", data: base64(svg) } });
    assert.equal(mine.statusCode, 200, mine.payload);
    assert.deepEqual([mine.json.shared, mine.json.editable, mine.json.url], [false, true, "http://nas.local:8096/web/"]);
    assert.deepEqual(await names(alice), ["Jellyfin"]);
    // Not on anyone else's desktop, an administrator's included.
    assert.deepEqual(await names(bob), []);
    assert.deepEqual(await names(admin), []);
    for (const other of [bob, admin]) {
      assert.equal((await other.get(`/api/external-apps/${mine.json.id}/icon`)).statusCode, 404);
      assert.equal((await other.put(`/api/external-apps/${mine.json.id}`, { name: "Taken", url: "http://evil.example" })).statusCode, 404);
      assert.equal((await other.delete(`/api/external-apps/${mine.json.id}`)).statusCode, 404);
    }
    assert.deepEqual(await names(alice), ["Jellyfin"]);

    // The icon was rewritten as it was taken in, and is sent as something that cannot run.
    const icon = await alice.get(mine.json.icon);
    assert.equal(icon.statusCode, 200);
    assert.equal(icon.headers["content-type"], "image/svg+xml");
    assert.match(icon.headers["content-security-policy"], /sandbox/);
    assert.equal(icon.headers["x-content-type-options"], "nosniff");
    assert.equal(icon.payload.includes("script"), false);
    assert.equal(icon.payload.includes("onload"), false);
    assert.ok(icon.payload.includes('d="M0 0h4"'));

    // An address is a web address and nothing else.
    for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "ftp://nas.local", "nas.local:8096", "//nas.local", "http://", "http://user:secret@nas.local"]) {
      const response = await alice.post("/api/external-apps", { name: "Bad", url });
      assert.equal(response.statusCode, 400, url);
      assert.equal((await alice.put(`/api/external-apps/${mine.json.id}`, { name: "Jellyfin", url })).statusCode, 400, url);
    }
    // And an icon is a picture.
    for (const data of [base64("<html><script>alert(1)</script></html>"), base64(`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`), base64("GIF89a")]) {
      assert.equal((await alice.post("/api/external-apps", { name: "Bad", url: "http://nas.local", icon: { kind: "upload", data } })).statusCode, 422);
    }
    assert.equal((await alice.post("/api/external-apps", { name: "Bad", url: "http://nas.local", icon: { kind: "upload", data: "not base64!" } })).statusCode, 400);
    assert.equal((await alice.post("/api/external-apps", { name: "Bad", url: "http://nas.local", icon: { kind: "upload", data: "A".repeat(2 * 1024 * 1024) } })).statusCode, 400);
    assert.equal((await alice.post("/api/external-apps", { name: "Bad", url: "http://nas.local", icon: { kind: "url", url: "http://169.254.169.254/latest/meta-data" } })).statusCode, 400);
    assert.deepEqual(await names(alice), ["Jellyfin"]);

    // A shortcut opens in a tab of its own unless it was asked to be shown inside Kago; only then is there a frame for it.
    assert.equal(mine.json.embed, false);
    assert.equal((await alice.get(`/api/external-apps/${mine.json.id}/frame`)).statusCode, 404);
    const framed = await alice.post("/api/external-apps", { name: "Framed", url: 'http://nas.local:8096/web/?a=1&b="><script>alert(1)</script>', embed: true });
    assert.equal(framed.statusCode, 200, framed.payload);
    assert.equal(framed.json.embed, true);
    // Saying nothing of it leaves it as it was.
    assert.equal((await alice.put(`/api/external-apps/${framed.json.id}`, { name: "Framed", url: framed.json.url })).json.embed, true);
    const frame = await alice.get(`/api/external-apps/${framed.json.id}/frame`);
    assert.equal(frame.statusCode, 200);
    assert.match(frame.headers["content-type"], /^text\/html/);
    // The page can hold a frame and nothing else, and only Kago can hold the page.
    assert.match(frame.headers["content-security-policy"], /default-src 'none'/);
    assert.match(frame.headers["content-security-policy"], /frame-ancestors 'self'/);
    assert.equal(frame.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(frame.headers["cache-control"], "no-store");
    // The address is written into it as an address, whatever it holds, and the service is not handed Kago's tab.
    assert.equal((frame.payload.match(/<iframe /g) ?? []).length, 1);
    assert.equal(frame.payload.includes("<script"), false);
    assert.ok(frame.payload.includes('src="http://nas.local:8096/web/?a=1&amp;b=%22%3E%3Cscript%3Ealert(1)%3C/script%3E"'), frame.payload);
    assert.match(frame.payload, /sandbox="[^"]*allow-scripts[^"]*"/);
    assert.equal(frame.payload.includes("allow-top-navigation"), false);
    // It is there for whoever has the shortcut, and for nobody else.
    for (const other of [bob, admin, stranger]) assert.notEqual((await other.get(`/api/external-apps/${framed.json.id}/frame`)).statusCode, 200);
    assert.equal((await alice.put(`/api/external-apps/${framed.json.id}`, { name: "Framed", url: framed.json.url, embed: false })).json.embed, false);
    assert.equal((await alice.get(`/api/external-apps/${framed.json.id}/frame`)).statusCode, 404);
    assert.equal((await alice.delete(`/api/external-apps/${framed.json.id}`)).statusCode, 200);

    // A sign-in for a service that asks with the browser's own box is kept sealed, and leaves the server only as the shortcut is opened.
    const password = "p@ss word/ö:#1";
    const signed = await alice.post("/api/external-apps", { name: "Signed", url: "http://nas.local:8096/web/?a=1", embed: true, auth: { username: "alice smith", password } });
    assert.equal(signed.statusCode, 200, signed.payload);
    assert.equal(signed.json.authUser, "alice smith");
    assert.equal(signed.payload.includes(password), false);
    assert.equal((await alice.get("/api/external-apps")).payload.includes(password), false);
    const signedIn = async (who, id = signed.json.id) => {
      const response = await who.get(`/api/external-apps/${id}/open`);
      if (response.statusCode !== 302) return response.statusCode;
      const target = new URL(response.headers.location);
      return [decodeURIComponent(target.username), decodeURIComponent(target.password), target.host + target.pathname + target.search];
    };
    assert.deepEqual(await signedIn(alice), ["alice smith", password, "nas.local:8096/web/?a=1"]);
    const opened = await alice.get(`/api/external-apps/${signed.json.id}/open`);
    assert.equal(opened.headers["cache-control"], "no-store");
    assert.equal(opened.headers["referrer-policy"], "no-referrer");
    // A browser takes no sign-in into a frame, so the frame is never given one.
    const signedFrame = await alice.get(`/api/external-apps/${signed.json.id}/frame`);
    assert.ok(signedFrame.payload.includes('src="http://nas.local:8096/web/?a=1"'), signedFrame.payload);
    for (const other of [bob, admin, stranger]) assert.notEqual((await other.get(`/api/external-apps/${signed.json.id}/open`)).statusCode, 302);
    // A change that names no password keeps the one there was; one that names no sign-in at all keeps both.
    assert.equal((await alice.put(`/api/external-apps/${signed.json.id}`, { name: "Signed", url: signed.json.url, auth: { username: "alice2" } })).json.authUser, "alice2");
    assert.deepEqual(await signedIn(alice), ["alice2", password, "nas.local:8096/web/?a=1"]);
    assert.equal((await alice.put(`/api/external-apps/${signed.json.id}`, { name: "Renamed", url: signed.json.url })).json.authUser, "alice2");
    assert.deepEqual(await signedIn(alice), ["alice2", password, "nas.local:8096/web/?a=1"]);
    assert.equal((await alice.put(`/api/external-apps/${signed.json.id}`, { name: "Renamed", url: signed.json.url, auth: { username: "alice2", password: "" } })).statusCode, 200);
    assert.deepEqual(await signedIn(alice), ["alice2", "", "nas.local:8096/web/?a=1"]);
    for (const auth of [{ username: "a:b", password: "x" }, { username: "", password: "x" }, { username: "a", password: "x\ny" }, { username: "a\u0000" }, "alice:secret"]) {
      assert.equal((await alice.put(`/api/external-apps/${signed.json.id}`, { name: "Renamed", url: signed.json.url, auth })).statusCode, 400, JSON.stringify(auth));
    }
    // A sign-in still has no place in the address itself, where it would be shown and logged.
    assert.equal((await alice.put(`/api/external-apps/${signed.json.id}`, { name: "Renamed", url: "http://alice2:secret@nas.local:8096/" })).statusCode, 400);
    assert.equal((await alice.put(`/api/external-apps/${signed.json.id}`, { name: "Renamed", url: signed.json.url, auth: null })).json.authUser, null);
    assert.deepEqual(await signedIn(alice), ["", "", "nas.local:8096/web/?a=1"]);
    assert.equal((await alice.delete(`/api/external-apps/${signed.json.id}`)).statusCode, 200);
    // One an administrator shares signs everyone who has it in; nobody but an administrator can change what it signs in as.
    const sharedSignIn = await admin.post("/api/external-apps", { name: "Shared sign-in", url: "http://nas.local:9000", shared: true, auth: { username: "household", password } });
    assert.deepEqual(await signedIn(bob, sharedSignIn.json.id), ["household", password, "nas.local:9000/"]);
    assert.equal((await bob.put(`/api/external-apps/${sharedSignIn.json.id}`, { name: "Shared sign-in", url: "http://evil.example", auth: { username: "household" } })).statusCode, 403);
    // The password is in neither the audit log nor the database as it was typed.
    assert.equal((await admin.get("/api/audit")).payload.includes(password), false);
    const database = new DatabaseSync(path.join(fixture.appDataDir, "app.db"), { readOnly: true });
    const stored = database.prepare("SELECT auth_user, auth_secret FROM external_apps WHERE id = ?").get(sharedSignIn.json.id);
    database.close();
    assert.equal(stored.auth_user, "household");
    assert.match(stored.auth_secret, /^v1:/);
    assert.equal(stored.auth_secret.includes(password), false);
    assert.equal((await admin.delete(`/api/external-apps/${sharedSignIn.json.id}`)).statusCode, 200);

    // Sharing with everyone is an administrator's to do, whether at the start or later.
    assert.equal((await alice.post("/api/external-apps", { name: "Mine for all", url: "http://nas.local", shared: true })).statusCode, 403);
    assert.equal((await alice.put(`/api/external-apps/${mine.json.id}`, { name: "Jellyfin", url: "http://nas.local:8096", shared: true })).statusCode, 403);
    assert.deepEqual(await names(bob), []);

    const shared = await admin.post("/api/external-apps", { name: "Home Assistant", url: "https://ha.example.test", shared: true, icon: { kind: "upload", data: base64(PNG) } });
    assert.equal(shared.statusCode, 200, shared.payload);
    assert.deepEqual([shared.json.shared, shared.json.editable], [true, true]);
    assert.deepEqual(await names(bob), ["Home Assistant"]);
    // Everyone's come before one's own.
    assert.deepEqual(await names(alice), ["Home Assistant", "Jellyfin"]);
    assert.equal((await bob.get("/api/external-apps")).json[0].editable, false);
    assert.equal((await bob.get(shared.json.icon)).headers["content-type"], "image/png");
    assert.equal((await bob.put(`/api/external-apps/${shared.json.id}`, { name: "Hijacked", url: "http://evil.example" })).statusCode, 403);
    assert.equal((await bob.put(`/api/external-apps/${shared.json.id}`, { name: "Hijacked", url: "http://evil.example", shared: false })).statusCode, 403);
    assert.equal((await bob.delete(`/api/external-apps/${shared.json.id}`)).statusCode, 403);
    assert.deepEqual((await bob.get("/api/external-apps")).json.map((item) => [item.name, item.url]), [["Home Assistant", "https://ha.example.test/"]]);

    // A change that says nothing about the icon keeps it; one that names no icon takes it away.
    const renamed = await admin.put(`/api/external-apps/${shared.json.id}`, { name: "Home", url: "https://ha.example.test" });
    assert.equal(renamed.json.icon, shared.json.icon);
    const bare = await admin.put(`/api/external-apps/${shared.json.id}`, { name: "Home", url: "https://ha.example.test", icon: { kind: "none" } });
    assert.equal(bare.json.icon, null);
    assert.equal((await bob.get(shared.json.icon)).statusCode, 404);

    // Taken back from everyone, it is the administrator's alone.
    assert.equal((await admin.put(`/api/external-apps/${shared.json.id}`, { name: "Home", url: "https://ha.example.test", shared: false })).json.shared, false);
    assert.deepEqual(await names(bob), []);
    assert.deepEqual(await names(admin), ["Home"]);

    assert.equal((await alice.delete(`/api/external-apps/${mine.json.id}`)).statusCode, 200);
    assert.deepEqual(await names(alice), []);
    assert.equal((await alice.get(mine.json.icon)).statusCode, 404);
    assert.deepEqual(await readdir(path.join(fixture.appDataDir, "app-icons", "apps")), []);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

async function createFixture() {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-external-apps."));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  await mkdir(path.join(dataDir, "photos"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  return { baseDir, dataDir, appDataDir };
}

function client(app) {
  let cookie = "";

  return {
    get: (url) => request("GET", url),
    post: (url, body) => request("POST", url, body),
    put: (url, body) => request("PUT", url, body),
    delete: (url) => request("DELETE", url)
  };

  async function request(method, url, body) {
    const headers = {
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
      ...(method === "GET" ? {} : { "x-kago-csrf": "1" })
    };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    const response = await app.inject({ method, url, headers, payload });
    const setCookies = response.headers["set-cookie"];
    for (const setCookie of Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []) {
      const pair = setCookie.split(";", 1)[0];
      const [name] = pair.split("=");
      cookie = cookie.split("; ").filter((value) => value && !value.startsWith(`${name}=`)).concat(pair).join("; ");
    }
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      json: String(response.headers["content-type"] ?? "").includes("application/json") && response.payload ? JSON.parse(response.payload) : null,
      payload: response.payload
    };
  }
}
