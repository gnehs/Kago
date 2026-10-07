// Writes THIRD-PARTY-NOTICES from the production dependencies that are installed, so run it after `pnpm install`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const APPS = ["apps/server", "apps/web"];
const LICENSE_FILE = /^(licen[sc]e|copying|copyright|notice)/i;
const RULE = "-".repeat(80);

const HEADER = `Kago 第三方軟體聲明
====================

Kago 本身以 AGPL-3.0-only 授權，條文見 LICENSE。這份文件列出隨 Kago 一起散布的
第三方軟體，以及它們各自的授權條款。本檔由 scripts/third-party-notices.mjs 產生，
請不要手動修改；相依套件有變動時執行 \`pnpm notices\` 重新產生。


Docker 映像檔內含的程式
------------------------

以下程式不是 Kago 的一部分，只是和 Kago 放在同一個映像檔裡，各自依自己的授權散布。

jellyfin-ffmpeg（ffmpeg、ffprobe）
  授權：GPL-3.0-or-later
  原始碼：https://github.com/jellyfin/jellyfin-ffmpeg
  映像檔內的授權檔：/usr/share/doc/jellyfin-ffmpeg8/copyright
  Kago 以獨立行程呼叫它，沒有與它連結。

rclone
  授權：MIT
  原始碼：https://github.com/rclone/rclone
  Kago 以獨立行程呼叫它來連線遠端位置，沒有與它連結。

  Copyright (C) 2012 by Nick Craig-Wood http://www.craig-wood.com/nick/

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
  THE SOFTWARE.

Node.js
  授權：MIT，另含其內建元件各自的授權
  原始碼：https://github.com/nodejs/node

Debian 基礎映像檔中的其他套件，授權檔位於映像檔內的 /usr/share/doc/*/copyright。


npm 套件
--------

伺服器的相依套件安裝在映像檔內，網頁前端的相依套件則打包進前端的靜態檔案。
授權條文完全相同的套件列在一起。
`;

/** Looks a dependency up the way Node does, which is also how pnpm's symlinked layout expects to be read. */
function locate(from, name) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    if (dir === path.dirname(dir)) throw new Error(`${name} is not installed (needed by ${from}); run pnpm install first`);
  }
}

const packages = new Map();

// Optional dependencies are left out: they are platform-specific native builds that neither the web bundle nor the server uses.
function collect(from, names) {
  for (const name of names) {
    const dir = locate(from, name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const id = `${pkg.name}@${pkg.version}`;
    if (packages.has(id)) continue;
    // Some packages keep the notices of what they bundle next to the build rather than at the top, as libass-wasm does.
    const text = [...new Set([dir, path.join(dir, path.dirname(pkg.main ?? "."))])]
      .flatMap((folder) =>
        fs
          .readdirSync(folder)
          .filter((file) => LICENSE_FILE.test(file) && fs.statSync(path.join(folder, file)).isFile())
          .sort()
          .map((file) => fs.readFileSync(path.join(folder, file), "utf8").replace(/\r\n/g, "\n").trim())
      )
      .join("\n\n");
    const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    packages.set(id, {
      id,
      license: typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? "未標示"),
      url: pkg.homepage ?? repository ?? `https://www.npmjs.com/package/${pkg.name}`,
      text
    });
    collect(dir, Object.keys(pkg.dependencies ?? {}));
  }
}

for (const app of APPS) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, app, "package.json"), "utf8"));
  collect(path.join(root, app), Object.keys(pkg.dependencies ?? {}));
}

const groups = new Map();
for (const pkg of [...packages.values()].sort((a, b) => a.id.localeCompare(b.id, "en"))) {
  // A package without a licence file still gets an entry of its own, stating the licence its manifest declares.
  const key = pkg.text ? createHash("sha256").update(pkg.text).digest("hex") : pkg.id;
  const group = groups.get(key) ?? { text: pkg.text, members: [] };
  group.members.push(pkg);
  groups.set(key, group);
}

const sections = [...groups.values()].map(({ text, members }) =>
  [RULE, ...members.map((pkg) => `${pkg.id}\n  授權：${pkg.license}\n  ${pkg.url}`), RULE, "", text || "（套件未附授權檔，授權以上方標示為準。）", ""].join("\n")
);

fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES"), `${HEADER}\n${sections.join("\n")}`);
console.log(`THIRD-PARTY-NOTICES: ${packages.size} packages, ${groups.size} licence texts`);
