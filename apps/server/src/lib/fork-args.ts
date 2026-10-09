/** What a forked child is started with: the source TypeScript loader in development, without parent-only flags such as --eval and --test. */
export function loaderExecArgv(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index]!;
    if (arg === "--require" || arg === "-r" || arg === "--import") {
      const value = process.execArgv[index + 1];
      if (value !== undefined) args.push(arg, value);
      index += 1;
    } else if (arg.startsWith("--require=") || arg.startsWith("--import=")) {
      args.push(arg);
    }
  }
  return args;
}
