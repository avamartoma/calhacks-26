import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import express, { type NextFunction, type Request, type Response } from "express";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.ENV_HOST_SECRET ?? "";
const PUBLIC_IP = process.env.PUBLIC_IP ?? "127.0.0.1";
const MODE = process.env.ENV_HOST_MODE === "stub" ? "stub" : "docker";
const IMAGE = process.env.AGENT_ENV_IMAGE ?? "agent-env";
const ENV_TOKEN = process.env.AGENT_ENV_TOKEN || SECRET;
const GIT_TOKEN = process.env.GIT_TOKEN ?? "";
const POOL_SIZE = Number(process.env.POOL_SIZE ?? 3);
const HEALTH_TIMEOUT_MS = 60_000;
const ID_RE = /^[A-Za-z0-9]+$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

if (!SECRET) {
  console.error("ENV_HOST_SECRET is required");
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be an integer from 1 to 65535");
  process.exit(1);
}
if (!Number.isInteger(POOL_SIZE) || POOL_SIZE < 0) {
  console.error("POOL_SIZE must be an integer >= 0");
  process.exit(1);
}

type IdleSlot = {
  name: string;
  port: number;
  token: string;
  url: string;
};

type Session = IdleSlot & {
  id: string;
  repoUrl: string;
  branch: string;
  origin: "pool" | "cold";
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const idle: IdleSlot[] = [];
const sessions = new Map<string, Session>();
const inflight = new Map<string, Promise<string>>();
let booting = 0;

function isHttpsGitUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isSafeBranch(branch: string): boolean {
  return BRANCH_RE.test(branch) && !branch.includes("..") && !branch.endsWith("/") && !branch.includes("//");
}

function authorized(req: Request): boolean {
  const header = req.header("authorization") ?? "";
  return header === SECRET || header === `Bearer ${SECRET}`;
}

function requireAuth(req: Request): void {
  if (!authorized(req)) {
    throw new HttpError(401, "unauthorized");
  }
}

function publicUrl(port: number): string {
  return `http://${PUBLIC_IP}:${port}`;
}

function readLaunchBody(body: unknown): { id: string; repoUrl: string; branch: string; token?: string } {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const { id, repoUrl, branch } = record;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new HttpError(400, "id must be alphanumeric");
  }
  if (typeof repoUrl !== "string" || !isHttpsGitUrl(repoUrl)) {
    throw new HttpError(400, "repoUrl must be an https git URL");
  }
  if (typeof branch !== "string" || !isSafeBranch(branch)) {
    throw new HttpError(400, "branch must be a safe git branch name");
  }
  let token: string | undefined;
  if ("token" in record && record.token !== undefined) {
    if (typeof record.token !== "string" || /[\r\n]/.test(record.token)) {
      throw new HttpError(400, "token must be a single-line string");
    }
    token = record.token;
  }
  return { id, repoUrl, branch, token };
}

function readId(id: string | string[] | undefined): string {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new HttpError(400, "id must be alphanumeric");
  }
  return id;
}

function claimedCount(): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.origin === "pool") count += 1;
  }
  return count;
}

function logReady(id: string, started: number, via: "pool" | "cold", url: string): void {
  console.log(`session ${id} ready in ${Date.now() - started}ms via ${via} ${url}`);
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function docker(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, { timeout: 120_000, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    const message = error instanceof Error ? error.message : "docker failed";
    throw new HttpError(500, `docker ${args[0]} failed: ${(stderr || message).slice(0, 500)}`);
  }
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "connection failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new HttpError(504, `container did not become healthy within 60s (${lastError})`);
}

async function destroyContainer(name: string): Promise<boolean> {
  if (MODE === "stub") return false;
  try {
    await execFileAsync("docker", ["rm", "-f", name], { timeout: 30_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function containerEnv(extra: string[], gitToken?: string): string[] {
  const args = ["-e", `ENV_TOKEN=${ENV_TOKEN}`];
  const token = gitToken || GIT_TOKEN;
  if (token) args.push("-e", `GIT_TOKEN=${token}`);
  args.push(...extra);
  return args;
}

async function bootIdle(): Promise<IdleSlot> {
  const poolId = randomBytes(8).toString("hex");
  const name = `p-${poolId}`;
  const port = await reservePort();
  if (MODE === "docker") {
    try {
      await docker([
        "run",
        "-d",
        "--runtime",
        "runsc",
        "--name",
        name,
        "--label",
        "iteration1=pool",
        "-p",
        `${port}:3000`,
        ...containerEnv([]),
        IMAGE,
      ]);
      await waitForHealth(port);
    } catch (error) {
      await destroyContainer(name);
      throw error;
    }
  }
  return { name, port, token: ENV_TOKEN, url: publicUrl(port) };
}

function scheduleRefill(): void {
  while (idle.length + booting < POOL_SIZE) {
    booting += 1;
    void bootIdle()
      .then((slot) => {
        idle.push(slot);
        console.log(`pool refill ${slot.name} -> ${slot.url} idle=${idle.length}`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "pool boot failed";
        console.error(`pool refill failed: ${message}`);
      })
      .finally(() => {
        booting -= 1;
      });
  }
}

async function fillPool(): Promise<void> {
  const results = await Promise.allSettled(Array.from({ length: POOL_SIZE }, () => bootIdle()));
  for (const result of results) {
    if (result.status === "fulfilled") idle.push(result.value);
    else console.error(`pool boot failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
  }
  console.log(`pool ready idle=${idle.length} target=${POOL_SIZE}`);
}

async function attachContainer(slot: IdleSlot, repoUrl: string, branch: string, token?: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${slot.port}/attach`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${slot.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repoUrl, branch, ...(token ? { token } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HttpError(502, `attach failed: ${text.slice(0, 500)}`);
  }
}

async function coldStart(id: string, repoUrl: string, branch: string, token?: string): Promise<Session> {
  const name = `s-${id}`;
  const port = await reservePort();
  if (MODE === "docker") {
    try {
      await docker([
        "run",
        "-d",
        "--runtime",
        "runsc",
        "--name",
        name,
        "--label",
        "iteration1=session",
        "--label",
        `session=${id}`,
        "-p",
        `${port}:3000`,
        ...containerEnv([`-e`, `REPO=${repoUrl}`, `-e`, `BRANCH=${branch}`], token),
        IMAGE,
      ]);
      await waitForHealth(port);
    } catch (error) {
      await destroyContainer(name);
      throw error;
    }
  }
  return {
    id,
    name,
    port,
    token: ENV_TOKEN,
    url: publicUrl(port),
    repoUrl,
    branch,
    origin: "cold",
  };
}

async function launchSession(id: string, repoUrl: string, branch: string, token: string | undefined, started: number): Promise<string> {
  const slot = idle.shift();
  if (slot) {
    scheduleRefill();
    const session: Session = { ...slot, id, repoUrl, branch, origin: "pool" };
    sessions.set(id, session);
    try {
      if (MODE === "docker") await attachContainer(slot, repoUrl, branch, token);
      logReady(id, started, "pool", slot.url);
      return slot.url;
    } catch (error) {
      sessions.delete(id);
      await destroyContainer(slot.name);
      const message = error instanceof Error ? error.message : "attach failed";
      console.error(`pool claim failed for ${id}, using cold start: ${message}`);
    }
  }
  const session = await coldStart(id, repoUrl, branch, token);
  sessions.set(id, session);
  logReady(id, started, "cold", session.url);
  return session.url;
}

async function ensureSession(id: string, repoUrl: string, branch: string, token?: string): Promise<string> {
  const existing = sessions.get(id);
  if (existing) {
    if (existing.repoUrl !== repoUrl || existing.branch !== branch) {
      throw new HttpError(409, `env ${id} is already running with different settings`);
    }
    return existing.url;
  }
  const pending = inflight.get(id);
  if (pending) return pending;
  const started = Date.now();
  const work = launchSession(id, repoUrl, branch, token, started).finally(() => {
    inflight.delete(id);
  });
  inflight.set(id, work);
  return work;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, mode: MODE });
});

app.get("/pool", (req, res) => {
  requireAuth(req);
  res.json({ idle: idle.length, claimed: claimedCount() });
});

app.post("/envs", wrap(async (req, res) => {
  requireAuth(req);
  const { id, repoUrl, branch, token } = readLaunchBody(req.body);
  const url = await ensureSession(id, repoUrl, branch, token);
  res.json({ url });
}));

app.delete("/envs/:id", wrap(async (req, res) => {
  requireAuth(req);
  const id = readId(req.params.id);
  const session = sessions.get(id);
  if (!session) {
    const removed = await destroyContainer(`s-${id}`);
    res.json({ ok: true, removed });
    return;
  }
  sessions.delete(id);
  if (MODE === "docker") await destroyContainer(session.name);
  console.log(`removed ${session.name} for ${id}; not returned to the pool`);
  res.json({ ok: true, removed: true });
}));

app.get("/envs", (req, res) => {
  requireAuth(req);
  res.json({
    envs: [...sessions.values()].map((session) => ({
      id: session.id,
      url: session.url,
      repoUrl: session.repoUrl,
      branch: session.branch,
      origin: session.origin,
    })),
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: "invalid JSON" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

async function main(): Promise<void> {
  if (MODE === "docker") {
    try {
      await execFileAsync("docker", ["version"], { timeout: 15_000, windowsHide: true });
    } catch {
      console.error("docker is required. Set ENV_HOST_MODE=stub to run without containers.");
      process.exit(1);
    }
  }
  await fillPool();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`iteration1 env-host (${MODE}) listening on http://127.0.0.1:${PORT}`);
  });
}

void main();
