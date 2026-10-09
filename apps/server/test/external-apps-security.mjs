import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../dist/app.js";
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
