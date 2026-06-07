import { loadEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { logger } from "./lib/logger.js";

const env = loadEnv();
const app = await buildApp(env);

await app.listen({ host: "0.0.0.0", port: env.port });
logger.info(`Kago listening on http://0.0.0.0:${env.port}`);
