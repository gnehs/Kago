// Checks the web interface's dictionaries against the English messages the code passes to t() and the server sends:
// lists what each language has yet to translate and what it translates that is no longer used.
import fs from "node:fs";
import path from "node:path";

const src = path.join(import.meta.dirname, "../apps/web/src");
const serverSrc = path.join(import.meta.dirname, "../apps/server/src");
const localesDir = path.join(src, "locales");
const literal = String.raw`"((?:[^"\\]|\\.)*)"`;

const used = new Set();
for (const entry of fs.readdirSync(src, { recursive: true, withFileTypes: true })) {
  const file = path.join(entry.parentPath, entry.name);
  if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || file.startsWith(localesDir)) continue;
  for (const match of fs.readFileSync(file, "utf8").matchAll(new RegExp(String.raw`\bt\(\s*${literal}`, "g"))) used.add(JSON.parse(`"${match[1]}"`));
}

// What the server says when a request or a task fails reaches the interface in English and is translated there.
const serverMessages = [String.raw`new AppError\(\s*\d+,\s*${literal}`, String.raw`\b(?:reason|error): ${literal}`, String.raw`\breason \?\? ${literal}`, String.raw`\berrorMessage = ${literal}`, String.raw`error\.message : ${literal}`];
for (const entry of fs.readdirSync(serverSrc, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const text = fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8");
  for (const pattern of serverMessages) for (const match of text.matchAll(new RegExp(pattern, "g"))) used.add(JSON.parse(`"${match[1]}"`));
}

const placeholders = (text) => [...new Set(text.match(/\{\w+\}/g))].sort().join(" ");

let problems = 0;
for (const name of fs.readdirSync(localesDir).sort()) {
  const entries = new Map();
  for (const match of fs.readFileSync(path.join(localesDir, name), "utf8").matchAll(new RegExp(String.raw`^\s*${literal}:\s*${literal},?$`, "gm"))) {
    entries.set(JSON.parse(`"${match[1]}"`), JSON.parse(`"${match[2]}"`));
  }
  const report = [
    ...[...used].filter((message) => !entries.has(message)).map((message) => `  missing  ${JSON.stringify(message)}`),
    ...[...entries.keys()].filter((message) => !used.has(message)).map((message) => `  unused   ${JSON.stringify(message)}`),
    // English may spell a message out twice, as `one | other`; each form names the same placeholders.
    ...[...entries].filter(([message, text]) => placeholders(message) !== placeholders(text)).map(([message]) => `  {names}  ${JSON.stringify(message)}`)
  ];
  problems += report.length;
  console.log(`${name}: ${report.length === 0 ? `${entries.size} messages, complete` : `${report.length} to fix`}`);
  for (const line of report) console.log(line);
}

process.exit(problems === 0 ? 0 : 1);
