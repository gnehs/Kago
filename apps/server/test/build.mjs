import { execSync } from "node:child_process";

// Suites run side by side under the root `pnpm test`, and each compiling into the one `dist` let a suite import a file
// another was halfway through writing. The root script compiles once and says so; a suite run on its own compiles here.
if (!process.env.KAGO_SERVER_BUILT) execSync("pnpm run build", { stdio: "inherit" });
