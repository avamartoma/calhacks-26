import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express, { type NextFunction, type Request, type Response } from "express";

const execFileAsync = promisify(execFile);
const PORT = 3000;
const TOKEN = process.env.ENV_TOKEN ?? "";
const WORKSPACE = path.resolve(process.env.WORKSPACE ?? "/workspace");
const MAX_TIMEOUT_MS = 120_000;

if (!TOKEN) {
  console.error("ENV_TOKEN is required");
  process.exit(1);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function authorized(req: Request): boolean {
  const header = req.header("authorization") ?? "";
  return header === `Bearer ${TOKEN}` || header === TOKEN;
}

function requireAuth(req: Request): void {
  if (!authorized(req)) {
    throw new HttpError(401, "unauthorized");
  }
}

function workspacePath(input: string): string {
  if (input.includes("\0")) {
    throw new HttpError(400, "invalid path");
  }
  const resolved = path.resolve(WORKSPACE, input);
  const relative = path.relative(WORKSPACE, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "path escapes /workspace");
  }
  return resolved;
}

function workspaceFile(input: string): string {
  const resolved = workspacePath(input);
  if (resolved === WORKSPACE) {
    throw new HttpError(400, "path must be a file inside /workspace");
  }
  return resolved;
}

function run(cmd: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { cwd, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-200_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-200_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function assertHttpsGitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "repoUrl must be an https git URL");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hostname.length === 0) {
    throw new HttpError(400, "repoUrl must be an https git URL");
  }
}

function assertBranch(branch: string): void {
  if (!BRANCH_RE.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.includes("//")) {
    throw new HttpError(400, "branch must be a safe git branch name");
  }
}

async function useCloneToken(token: string): Promise<void> {
  const askpass = path.join(tmpdir(), "git-askpass.sh");
  await writeFile(
    askpass,
    "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' git ;;\n  *) printf '%s\\n' \"$GIT_TOKEN\" ;;\nesac\n",
  );
  await chmod(askpass, 0o700);
  process.env.GIT_TOKEN = token;
  process.env.GIT_ASKPASS = askpass;
  process.env.GIT_TERMINAL_PROMPT = "0";
}

async function attachRepo(repoUrl: string, branch: string): Promise<void> {
  assertHttpsGitUrl(repoUrl);
  assertBranch(branch);
  let cloned = false;
  try {
    await access(path.join(WORKSPACE, ".git"));
    cloned = true;
  } catch {
    cloned = false;
  }
  if (!cloned) {
    await rm(WORKSPACE, { recursive: true, force: true });
    try {
      await execFileAsync("git", ["clone", repoUrl, WORKSPACE], { timeout: 60_000 });
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
      throw new HttpError(400, (stderr || "git clone failed").slice(0, 500));
    }
  } else {
    await git(["remote", "set-url", "origin", repoUrl]);
    await git(["fetch", "origin"]);
  }
  await git(["config", "user.email", "agent@iteration1.local"]);
  await git(["config", "user.name", "Iteration 1"]);
  try {
    await git(["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
    await git(["checkout", "-B", branch, `origin/${branch}`]);
  } catch {
    await git(["checkout", "-B", branch]);
  }
}

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: WORKSPACE, timeout: 60_000 });
    return stdout.trim();
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    const message = stderr || (error instanceof Error ? error.message : "git failed");
    throw new HttpError(400, message.slice(0, 500));
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/attach", wrap(async (req, res) => {
  requireAuth(req);
  const body = req.body as { repoUrl?: unknown; branch?: unknown };
  if (typeof body.repoUrl !== "string" || typeof body.branch !== "string") {
    throw new HttpError(400, "repoUrl and branch are required");
  }
  const token = (req.body as { token?: unknown }).token;
  if (token !== undefined && (typeof token !== "string" || /[\r\n]/.test(token))) {
    throw new HttpError(400, "token must be a single-line string");
  }
  if (typeof token === "string" && token.length > 0) await useCloneToken(token);
  await attachRepo(body.repoUrl, body.branch);
  res.json({ ok: true });
}));

app.post("/exec", wrap(async (req, res) => {
  requireAuth(req);
  const body = req.body as { cmd?: unknown; cwd?: unknown; timeoutMs?: unknown };
  if (typeof body.cmd !== "string" || body.cmd.trim().length === 0) {
    throw new HttpError(400, "cmd is required");
  }
  const cwd = body.cwd === undefined ? WORKSPACE : workspacePath(String(body.cwd));
  const timeoutMs = body.timeoutMs === undefined ? 60_000 : Number(body.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new HttpError(400, "timeoutMs must be an integer from 1 to 120000");
  }
  const result = await run(body.cmd, cwd, timeoutMs);
  res.json(result);
}));

app.get("/file", wrap(async (req, res) => {
  requireAuth(req);
  const raw = req.query.path;
  if (typeof raw !== "string") {
    throw new HttpError(400, "path is required");
  }
  const filePath = workspaceFile(raw);
  const content = await readFile(filePath, "utf8");
  res.json({ path: raw, content });
}));

app.put("/file", wrap(async (req, res) => {
  requireAuth(req);
  const body = req.body as { path?: unknown; content?: unknown };
  if (typeof body.path !== "string" || typeof body.content !== "string") {
    throw new HttpError(400, "path and content are required");
  }
  const filePath = workspaceFile(body.path);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body.content, "utf8");
  res.json({ ok: true });
}));

app.delete("/file", wrap(async (req, res) => {
  requireAuth(req);
  const body = req.body as { path?: unknown };
  if (typeof body.path !== "string") {
    throw new HttpError(400, "path is required");
  }
  await rm(workspaceFile(body.path), { force: true });
  res.json({ ok: true });
}));

app.post("/git/commit", wrap(async (req, res) => {
  requireAuth(req);
  const message = (req.body as { message?: unknown }).message;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new HttpError(400, "message is required");
  }
  await git(["add", "-A"]);
  await git(["commit", "-m", message.trim()]);
  const sha = await git(["rev-parse", "HEAD"]);
  res.json({ sha });
}));

app.post("/git/push", wrap(async (req, res) => {
  requireAuth(req);
  await git(["push", "-u", "origin", "HEAD"]);
  res.json({ ok: true });
}));

app.post("/git/pull", wrap(async (req, res) => {
  requireAuth(req);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  await git(["pull", "--ff-only", "origin", branch]);
  res.json({ ok: true });
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    res.status(404).json({ error: "file not found" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`agent-env listening on ${PORT}`);
});
