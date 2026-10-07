import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "../..");
const viteClientDir = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("vite"))), "../client");
const canaryName = `kago-vite-canary-${randomUUID()} space`;
const canaryBody = `KAGO_VITE_CANARY_${randomUUID()}`;
const serverDataDirs = [
  path.resolve(webRoot, "../server/data"),
  path.resolve(webRoot, "../server/app-data")
];
const createdDirectories = [];
const serverCanaryPaths = [
  path.join(serverDataDirs[0], `${canaryName}.txt`),
  path.join(serverDataDirs[1], `${canaryName}.key`),
  path.join(serverDataDirs[1], `${canaryName}.db`)
];
const defaultDeniedCanaryPath = path.join(webRoot, `${canaryName}.pem`);
const createdCanaryPaths = [];
const externalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "kago-vite-security-"));
const externalRelativePath = path.relative(repoRoot, externalDirectory);
const externalCanaryPath = path.join(externalDirectory, `${canaryName}.txt`);
const canaryPaths = [...serverCanaryPaths, defaultDeniedCanaryPath, externalCanaryPath];

async function ensureParentDirectory(filePath) {
  const directory = path.dirname(filePath);
  try {
    await fs.access(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: true });
    createdDirectories.push(directory);
  }
}

function request(server, requestPath) {
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string", "Vite did not listen on a TCP port");

  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port: address.port, path: requestPath }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`Timed out requesting ${requestPath}`)));
  });
}

function fsUrl(filePath) {
  return `/@fs${encodeURI(filePath.replaceAll(path.sep, "/"))}`;
}

function encodedFirstFilenameCharacter(filePath) {
  const slashIndex = filePath.lastIndexOf(path.sep);
  const prefix = filePath.slice(0, slashIndex + 1);
  const filename = filePath.slice(slashIndex + 1);
  const encodedCharacter = `%${filename.charCodeAt(0).toString(16)}`;
  return `/@fs${encodeURI(prefix.replaceAll(path.sep, "/"))}${encodedCharacter}${encodeURI(filename.slice(1))}`;
}

async function expectBlocked(server, requestPath, description) {
  const response = await request(server, requestPath);
  assert.notEqual(response.status, 200, `${description} unexpectedly returned 200`);
  return response.status;
}

let viteServer;
try {
  assert.ok(
    externalRelativePath === ".." || externalRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(externalRelativePath),
    "The external canary must be outside the workspace"
  );
  for (const canaryPath of canaryPaths) {
    await ensureParentDirectory(canaryPath);
    await fs.writeFile(canaryPath, canaryBody, { encoding: "utf8", flag: "wx" });
    createdCanaryPaths.push(canaryPath);
  }

  const testServerOptions = { port: 0, strictPort: true };
  if (process.env.KAGO_VITE_HOST) testServerOptions.host = "127.0.0.1";
  viteServer = await createServer({
    configFile: path.join(webRoot, "vite.config.ts"),
    root: webRoot,
    logLevel: "silent",
    server: testServerOptions
  });
  assert.equal(viteServer.config.server.fs.strict, true, "Vite fs strict mode must remain enabled");
  if (!process.env.KAGO_VITE_HOST) {
    assert.equal(viteServer.config.server.host, "127.0.0.1", "Vite dev must bind to loopback by default");
    assert.equal(viteServer.config.preview.host, "127.0.0.1", "Vite preview must bind to loopback by default");
  }
  assert.deepEqual(
    viteServer.config.server.fs.allow,
    [webRoot, viteClientDir],
    "Vite must allow the web package root and its internal client runtime only"
  );
  await viteServer.listen();

  const blockedStatuses = [];
  for (const [index, canaryPath] of canaryPaths.entries()) {
    const label = index < serverCanaryPaths.length
      ? "server-owned canary"
      : canaryPath === defaultDeniedCanaryPath
        ? "Vite default-deny canary"
        : "outside-workspace canary";
    blockedStatuses.push(await expectBlocked(viteServer, fsUrl(canaryPath), `${label} direct URL`));
    blockedStatuses.push(await expectBlocked(viteServer, encodedFirstFilenameCharacter(canaryPath), `${label} encoded filename URL`));
    const importResponse = await request(viteServer, `${fsUrl(canaryPath)}?import`);
    if (importResponse.status === 200) {
      assert.ok(!importResponse.body.includes(canaryBody), `${label} import URL exposed canary contents`);
      const importedUrl = importResponse.body.match(/export default\s+["']([^"']+)["']/)?.[1];
      assert.ok(importedUrl, `${label} import URL returned an unexpected response`);
      const origin = `http://127.0.0.1:${viteServer.httpServer.address().port}`;
      const importedRequest = new URL(importedUrl, origin);
      blockedStatuses.push(await expectBlocked(
        viteServer,
        importedRequest.pathname + importedRequest.search,
        `${label} imported asset URL`
      ));
    } else {
      assert.notEqual(importResponse.status, 200, `${label} import URL must not be served`);
      blockedStatuses.push(importResponse.status);
    }
  }

  const webRootUrl = webRoot.replaceAll(path.sep, "/");
  const canaryUrlName = encodeURIComponent(path.basename(serverCanaryPaths[0]));
  for (const [traversal, encoding] of [["..", "plain"], ["%2e%2e", "encoded"]]) {
    const traversalUrl = `/@fs${webRootUrl}/${traversal}/server/data/${canaryUrlName}`;
    blockedStatuses.push(await expectBlocked(viteServer, traversalUrl, `${encoding} canary traversal URL`));
  }

  const sourceResponse = await request(viteServer, "/src/main.tsx");
  assert.equal(sourceResponse.status, 200, "Vite must continue serving the frontend entry module");
  const dependencyUrl = sourceResponse.body.match(/(?:from\s*|import\s*)["']([^"']*\/node_modules\/\.vite\/deps\/[^"']+\.js(?:\?[^"']*)?)["']/)?.[1];
  assert.ok(dependencyUrl, "Vite must resolve a frontend package import from main.tsx");

  const dependencyRequestPath = new URL(dependencyUrl, "http://127.0.0.1").pathname + new URL(dependencyUrl, "http://127.0.0.1").search;
  const dependencyResponse = await request(viteServer, dependencyRequestPath);
  assert.equal(dependencyResponse.status, 200, "Vite must continue serving the optimized frontend dependency");

  console.log(`Vite security check passed: blocked ${blockedStatuses.length} fake-canary URLs and served the frontend entry plus an optimized dependency.`);
} finally {
  if (viteServer) await viteServer.close();
  for (const canaryPath of createdCanaryPaths) await fs.rm(canaryPath, { force: true });
  for (const directory of createdDirectories.reverse()) {
    try {
      await fs.rmdir(directory);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    }
  }
  await fs.rm(externalDirectory, { recursive: true, force: true });
}
