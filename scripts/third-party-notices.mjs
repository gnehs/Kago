// Writes THIRD-PARTY-NOTICES from the production dependencies that are installed, so run it after `pnpm install`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const APPS = ["apps/server", "apps/web"];
const LICENSE_FILE = /^(licen[sc]e|copying|copyright|notice)/i;
const RULE = "-".repeat(80);

const HEADER = `Kago third-party software notices
=================================

Kago itself is licensed under AGPL-3.0-only; the text is in LICENSE. This file lists the
third-party software distributed with Kago and the license each comes under. It is generated
by scripts/third-party-notices.mjs, so do not edit it by hand: run \`pnpm notices\` to
regenerate it when the dependencies change.


Programs included in the Docker image
-------------------------------------

The following programs are not part of Kago. They are placed in the same image and are each
distributed under their own license.

jellyfin-ffmpeg (ffmpeg, ffprobe)
  License: GPL-3.0-or-later
  Source: https://github.com/jellyfin/jellyfin-ffmpeg
  License file in the image: /usr/share/doc/jellyfin-ffmpeg8/copyright
  Kago runs it as a separate process and is not linked with it.

rclone
  License: MIT
  Source: https://github.com/rclone/rclone
  Kago runs it as a separate process to reach remote locations and is not linked with it.

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
  License: MIT, along with the licenses of the components it bundles
  Source: https://github.com/nodejs/node

The other packages of the Debian base image have their license files in the image, at
/usr/share/doc/*/copyright.


npm packages
------------

The server's dependencies are installed in the image; the web interface's are bundled into
its static files. Packages whose license text is exactly the same are listed together.

sharp also brings a libvips prebuilt for each platform (@img/sharp-libvips-*,
LGPL-3.0-or-later) and a native module of its own (@img/sharp-*, Apache-2.0). Which of them
is installed depends on the machine, so they are not in the list below. The server loads
them dynamically at run time, unmodified. For the libraries libvips contains and the license
of each, see https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md
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

// Optional dependencies are left out: they are platform-specific native builds, and which of them is installed depends
// on the machine this runs on. The one kind the server does load, sharp's, is named in the header instead.
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
      license: typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? "not stated"),
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
  [RULE, ...members.map((pkg) => `${pkg.id}\n  License: ${pkg.license}\n  ${pkg.url}`), RULE, "", text || "(The package comes with no license file; the license stated above applies.)", ""].join("\n")
);

fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES"), `${HEADER}\n${sections.join("\n")}`);
console.log(`THIRD-PARTY-NOTICES: ${packages.size} packages, ${groups.size} licence texts`);
