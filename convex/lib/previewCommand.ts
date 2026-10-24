const HOST_FLAGS = {
  next: (port: number) => `--hostname 0.0.0.0 --port ${port}`,
  other: (port: number) => `--host 0.0.0.0 --port ${port}`,
};

function recordOf(value: object, key: string): Record<string, unknown> {
  if (!(key in value)) return {};
  const entry = (value as Record<string, unknown>)[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  return entry as Record<string, unknown>;
}

/** The command used when the caller does not pass one. */
export function commandFromPackageJson(source: string, port: number): { command: string; install: string; serve: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("package.json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json is not an object");
  }
  const scripts = recordOf(parsed, "scripts");
  const dev = scripts.dev;
  if (typeof dev !== "string" || dev.trim().length === 0) {
    throw new Error("package.json has no dev script; pass command");
  }
  const deps = { ...recordOf(parsed, "dependencies"), ...recordOf(parsed, "devDependencies") };
  const flags = "next" in deps ? HOST_FLAGS.next(port) : HOST_FLAGS.other(port);
  const install = "npm install";
  const serve = `npm run dev -- ${flags}`;
  return { command: `${install} && ${serve}`, install, serve };
}
