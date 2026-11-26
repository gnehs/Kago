import { setTimeout as sleep } from "node:timers/promises";

/** A signed-in browser against an injected app: it keeps its cookies and sends the CSRF header on every change. */
export function client(app) {
  let cookie = "";
  async function request(method, url, body, accept = "application/json") {
    const headers = { accept, ...(cookie ? { cookie } : {}) };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["x-kago-csrf"] = "1";
    const response = await app.inject({ method, url, headers, payload });
    const values = response.headers["set-cookie"];
    for (const value of Array.isArray(values) ? values : values ? [values] : []) {
      const pair = value.split(";", 1)[0];
      if (!pair) continue;
      const [name] = pair.split("=");
      cookie = cookie.split("; ").filter((item) => !item.startsWith(`${name}=`)).concat(pair).join("; ");
    }
    const json = String(response.headers["content-type"] ?? "").includes("application/json") && response.payload ? JSON.parse(response.payload) : null;
    return { statusCode: response.statusCode, payload: response.payload, raw: response.rawPayload, json };
  }
  return {
    get: (url, options = {}) => request("GET", url, undefined, options.accept),
    post: (url, body) => request("POST", url, body),
    put: (url, body) => request("PUT", url, body)
  };
}

export async function waitTask(api, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await api.get(`/api/tasks/${taskId}`);
    if (["done", "failed", "cancelled", "interrupted"].includes(task.json.status)) return task.json;
    await sleep(50);
  }
  throw new Error(`Task ${taskId} did not finish`);
}

/** Asks `read` again until it gives something other than null or false, for what is settled by the server after the request that caused it has answered. */
export async function waitFor(read, what = "the condition") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Gave up waiting for ${what}`);
}
