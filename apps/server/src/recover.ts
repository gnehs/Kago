// A way back in for an administrator when nobody can sign in: the identity provider is down or set up wrongly, or
// the only administrators have no password. It is run on the machine itself (`node dist/recover.js <email>`), so
// being able to run it is the proof of being allowed to; nothing of it is reachable over the network.
import { loadEnv } from "./config/env.js";
import { openDb, row } from "./db/db.js";
import { hashPassword, randomToken } from "./lib/crypto.js";
import { id, now } from "./lib/ids.js";
import type { User } from "./services/types.js";

const args = process.argv.slice(2);
const disableSso = args.includes("--disable-sso");
const email = args.find((arg) => !arg.startsWith("--"))?.toLowerCase();

if ((!email && !disableSso) || (email && !/^[^\s@]+@[^\s@]+$/.test(email))) {
  console.error("Usage: node dist/recover.js <email> [--disable-sso]");
  console.error("  <email>         Gives this account a new password and makes it an enabled administrator; creates it if there is none.");
  console.error("  --disable-sso   Turns single sign-on off, so the sign-in page offers the password form again.");
  process.exit(1);
}

// The server may be running: its tasks are left alone.
const db = openDb(loadEnv(), { interruptRunningTasks: false });
const ts = now();
const audit = (action: string, target: unknown) =>
  db
    .prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, root_id, path, target_json, result, ip, user_agent, created_at) VALUES (?, 'system', NULL, ?, NULL, NULL, ?, 'success', NULL, NULL, ?)")
    .run(id("audit"), action, JSON.stringify(target), ts);

if (disableSso) {
  const stored = row<{ value_json: string }>(db.prepare("SELECT value_json FROM app_settings WHERE key = 'oidc'").get());
  if (stored) {
    db.prepare("UPDATE app_settings SET value_json = ?, updated_at = ? WHERE key = 'oidc'").run(JSON.stringify({ ...(JSON.parse(stored.value_json) as object), enabled: false, autoRedirect: false }), ts);
    audit("sso_update", { enabled: false, method: "recovery" });
  }
  console.log("Single sign-on is off. Its settings are kept and can be turned back on from Settings.");
}

if (email) {
  const password = randomToken();
  const hash = await hashPassword(password);
  const user = row<User>(db.prepare("SELECT * FROM users WHERE email = ?").get(email));
  if (user) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'ADMIN', disabled = 0, updated_at = ? WHERE id = ?").run(hash, ts, user.id);
    // Whoever held a session of this account before is signed out along with everyone else.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  } else {
    db.prepare("INSERT INTO users (id, email, password_hash, display_name, role, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 'ADMIN', 0, ?, ?)").run(id("user"), email, hash, "Kago Admin", ts, ts);
  }
  audit("admin_recovery", { email, created: !user });
  console.log(`${user ? "Reset" : "Created"} the administrator ${email}.`);
  console.log(`Password: ${password}`);
  console.log("Sign in at /login?local=1 and change it under Settings.");
}

db.close();
