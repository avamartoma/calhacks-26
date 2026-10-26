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

/**
 * A plain static site (no package.json, or one with nothing to run), served as files: the first of
 * the usual places with an index.html, GitHub Pages' root or docs/ first, otherwise the whole folder.
 */
export function staticCommand(port: number): { command: string; serve: string } {
  const serve = `for dir in . docs public dist build _site site; do if [ -f "$dir/index.html" ]; then exec python3 -m http.server ${port} --bind 0.0.0.0 --directory "$dir"; fi; done; exec python3 -m http.server ${port} --bind 0.0.0.0`;
  return { command: serve, serve };
}

/**
 * The command used when the caller does not pass one: the `dev` script, else `start` (PORT and
 * HOST are set for it), else the files served as a static site.
 */
export function commandFromPackageJson(source: string | null, port: number): { command: string; install?: string; serve: string } {
  if (source === null) return staticCommand(port);
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
  const install = "npm install";
  const dev = scripts.dev;
  if (typeof dev === "string" && dev.trim().length > 0) {
    const deps = { ...recordOf(parsed, "dependencies"), ...recordOf(parsed, "devDependencies") };
    const flags = "next" in deps ? HOST_FLAGS.next(port) : HOST_FLAGS.other(port);
    const serve = `npm run dev -- ${flags}`;
    return { command: `${install} && ${serve}`, install, serve };
  }
  const start = scripts.start;
  if (typeof start === "string" && start.trim().length > 0) {
    const serve = "npm start";
    return { command: `${install} && ${serve}`, install, serve };
  }
  return staticCommand(port);
}
