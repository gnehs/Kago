import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../dist/app.js";
import { pluginPolicy, PluginService } from "../src/services/plugin.service.ts";

const manifest = (name, api = 1, extra = {}) => ({
  name,
  version: "1.2.3",
  kago: { api, title: `Title of ${name}`, previewers: [{ id: "view", extensions: ["xyz", "ply"], entry: "index.html" }], ...extra }
});

async function addPlugin(root, folder, json, files = { "index.html": "<!doctype html><title>plugin</title>" }) {
  const dir = path.join(root, folder);
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), typeof json === "string" ? json : JSON.stringify(json));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, "dist", name)), { recursive: true });
    await writeFile(path.join(dir, "dist", name), body);
  }
  return dir;
}

async function createFixture() {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-plugins."));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  const pluginsDir = path.join(appDataDir, "plugins");
  await mkdir(dataDir, { recursive: true });
  await mkdir(pluginsDir, { recursive: true });
  return { baseDir, dataDir, appDataDir, pluginsDir };
}

test("only a plugin of this API version with its files built is loaded, and each extension goes to one previewer", async () => {
  const fixture = await createFixture();
  try {
    const first = path.join(fixture.baseDir, "first");
    const second = path.join(fixture.baseDir, "second");
    await addPlugin(first, "good", manifest("@kago/plugin-good"));
    await addPlugin(first, "future", manifest("future-plugin", 2));
    await addPlugin(first, "broken", "{ not json");
    await addPlugin(first, "plain", { name: "not-a-plugin", version: "1.0.0" });
    await addPlugin(first, "unbuilt", manifest("unbuilt-plugin"), {});
    await addPlugin(first, "escaping", { ...manifest("escaping-plugin"), kago: { ...manifest("x").kago, previewers: [{ id: "view", extensions: ["abc"], entry: "../package.json" }] } });
    await addPlugin(second, "duplicate", manifest("@kago/plugin-good"));
    await addPlugin(second, "later", { ...manifest("later-plugin"), kago: { ...manifest("x").kago, previewers: [{ id: "other", extensions: ["ply", "obj"], entry: "index.html" }] } });

    const plugins = new PluginService([first, second, path.join(fixture.baseDir, "missing")]);
    assert.deepEqual(plugins.plugins().map((plugin) => plugin.id).sort(), ["@kago/plugin-good", "later-plugin"]);
    const previewers = plugins.previewers();
    assert.deepEqual(previewers.map((previewer) => [previewer.pluginId, previewer.extensions]), [["@kago/plugin-good", ["xyz", "ply"]], ["later-plugin", ["obj"]]]);
    assert.match(previewers[0].src, /^\/_kago\/plugin\/[0-9a-f]{32}\/index\.html$/);
    // The same plugin is named differently by another server, or by this one after a restart.
    assert.notEqual(new PluginService([first]).previewers()[0].src, previewers[0].src);
  } finally {
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("a plugin's policy names its own folder in full and nothing wider", () => {
  const policy = pluginPolicy("abc", ["kago.example.test:8443", "kago.example.test:8443", "evil host", null]);
  assert.match(policy, /^sandbox allow-scripts; default-src 'none'/);
  assert.match(policy, /script-src http:\/\/kago\.example\.test:8443\/_kago\/plugin\/abc\/ https:\/\/kago\.example\.test:8443\/_kago\/plugin\/abc\/ 'wasm-unsafe-eval' blob:/);
  assert.match(policy, /connect-src blob: data:;/);
  assert.match(policy, /frame-ancestors 'self'/);
  assert.doesNotMatch(policy, /\*|evil|'self' |'unsafe-eval'/);
});

test("plugin files are served sandboxed from inside their folder only, and the API refuses a sandboxed frame", async () => {
  const fixture = await createFixture();
  const outside = path.join(fixture.baseDir, "secret.txt");
  await writeFile(outside, "secret");
  const dir = await addPlugin(fixture.pluginsDir, "good", manifest("good-plugin"), { "index.html": "<!doctype html><title>plugin</title>", "assets/main.js": "export {}" });
  await symlink(outside, path.join(dir, "dist", "leak.txt"));
  await addPlugin(fixture.pluginsDir, "future", manifest("future-plugin", 2));
  const app = await buildApp({ port: 0, dataDir: fixture.dataDir, appDataDir: fixture.appDataDir, sessionSecret: "plugin-test-session-secret-0123456789", nodeEnv: "test" });
  try {
    await app.ready();
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { "x-kago-csrf": "1" }, payload: { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" } });
    assert.equal(setup.statusCode, 200, setup.payload);
    const cookie = [setup.headers["set-cookie"]].flat().map((value) => value.split(";", 1)[0]).join("; ");
    const get = (url, headers = {}) => app.inject({ method: "GET", url, headers: { cookie, ...headers } });

    assert.equal((await app.inject({ method: "GET", url: "/api/plugins" })).statusCode, 401);
    const listed = (await get("/api/plugins")).json().previewers;
    const mine = listed.find((previewer) => previewer.pluginId === "good-plugin");
    assert.ok(mine, JSON.stringify(listed));
    assert.equal(listed.some((previewer) => previewer.pluginId === "future-plugin"), false);
    const folder = mine.src.replace(/index\.html$/, "");

    const page = await app.inject({ method: "GET", url: `${mine.src}?_o=${encodeURIComponent("https://kago.example.test")}`, headers: { host: "127.0.0.1:8080" } });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"], /^text\/html/);
    const policy = page.headers["content-security-policy"];
    assert.match(policy, /^sandbox allow-scripts;/);
    assert.ok(policy.includes(`script-src http://127.0.0.1:8080${folder} https://127.0.0.1:8080${folder} http://kago.example.test${folder} https://kago.example.test${folder} 'wasm-unsafe-eval' blob:`), policy);
    assert.doesNotMatch(policy, /\*/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["cross-origin-resource-policy"], "same-origin");
    // An origin that is not a plain web origin is left out, not written into the policy.
    for (const origin of ["javascript:alert(1)", "https://user:pw@kago.example.test", "https://kago.example.test/path", "https://a.test; script-src *"]) {
      const odd = await app.inject({ method: "GET", url: `${mine.src}?_o=${encodeURIComponent(origin)}`, headers: { host: "127.0.0.1:8080" } });
      assert.equal(odd.statusCode, 200);
      assert.doesNotMatch(odd.headers["content-security-policy"], /kago\.example\.test|a\.test|\*/, origin);
    }
    assert.equal((await get(`${folder}assets/main.js`)).statusCode, 200);

    // Nothing outside the folder, however the path is written, and nothing under a token no plugin has.
    for (const url of [`${folder}../../../package.json`, `${folder}%2e%2e/package.json`, `${folder}..%2fpackage.json`, `${folder}assets/..%2f..%2fpackage.json`, `${folder}leak.txt`, `${folder}%2fetc%2fpasswd`, `${folder}assets`, `${folder}`]) {
      const response = await get(url);
      // A path whose dot segments lead out of the plugin's folder is no plugin URL at all: the interface's own page answers it.
      assert.ok(response.statusCode === 404 || !String(response.headers["content-security-policy"]).startsWith("sandbox"), url);
      assert.doesNotMatch(response.payload, /secret|good-plugin/, url);
    }
    assert.equal((await get(`/_kago/plugin/${"0".repeat(32)}/index.html`)).statusCode, 404);
    assert.equal((await get("/_kago/plugin/not-a-token/index.html")).statusCode, 404);

    // The API answers no request a sandboxed frame makes, signed in or not, however its path is spelled.
    for (const url of ["/api/auth/me", "/api/plugins", "/%61pi/plugins"]) assert.equal((await get(url, { origin: "null" })).statusCode, 403, url);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, origin: "null", "x-kago-csrf": "1" } })).statusCode, 403);
    assert.equal((await get("/api/plugins", { origin: "http://localhost" })).statusCode, 200);
    assert.equal((await get("/api/plugins")).statusCode, 200);

    // A shortcut shown inside Kago still opens: its frame page is a navigation, which names no origin.
    const shortcut = await app.inject({ method: "POST", url: "/api/external-apps", headers: { cookie, "x-kago-csrf": "1", origin: "http://localhost" }, payload: { name: "Framed", url: "http://nas.local:8096/", embed: true } });
    assert.equal(shortcut.statusCode, 200, shortcut.payload);
    const frame = await get(`/api/external-apps/${shortcut.json().id}/frame`, { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" });
    assert.equal(frame.statusCode, 200);
    assert.match(frame.payload, /<iframe /);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});
