"use node";

import { Sandbox } from "e2b";
import { commandFromPackageJson } from "./previewCommand";
import { workspacePath } from "./workspacePath";

declare const process: { env: Record<string, string | undefined> };

export type SandboxHandle = {
  sandboxId: string;
  url: string;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type SandboxCreateInput = {
  repoCloneUrl: string;
  branch: string;
  token: string;
};

export type PreviewInput = {
  command?: string;
  port: number;
};

export type PreviewResult = {
  previewUrl: string;
  command: string;
};

export interface SandboxProvider {
  readonly name: "e2b" | "env-host";
  readonly workspaceDir: string;
  create(input: SandboxCreateInput): Promise<SandboxHandle>;
  createEmpty(): Promise<SandboxHandle>;
  exec(sandboxId: string, cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
  readFile(sandboxId: string, path: string): Promise<string>;
  writeFile(sandboxId: string, path: string, content: string): Promise<void>;
  deleteFile(sandboxId: string, path: string): Promise<void>;
  destroy(sandboxId: string): Promise<void>;
  setTimeout(sandboxId: string, timeoutMs: number): Promise<void>;
  startPreview(sandboxId: string, input: PreviewInput): Promise<PreviewResult>;
  resume(sandboxId: string): Promise<SandboxHandle>;
  pause(sandboxId: string): Promise<void>;
  portOpen(sandboxId: string, port: number): Promise<boolean>;
  archive(sandboxId: string): Promise<Uint8Array | null>;
  restore(sandboxId: string, archive: Uint8Array): Promise<void>;
  sandboxState(sandboxId: string): Promise<"running" | "paused" | "missing">;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function sandboxTimeoutMs(): number {
  const raw = process.env.E2B_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(parsed) || parsed < 60_000) {
    throw new Error("E2B_TIMEOUT_MS must be an integer of at least 60000");
  }
  return parsed;
}

export function sandboxMaxExtensions(): number {
  const raw = process.env.E2B_MAX_EXTENSIONS;
  const parsed = raw ? Number(raw) : 5;
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("E2B_MAX_EXTENSIONS must be an integer >= 0");
  }
  return parsed;
}

export function sandboxProviderName(): "e2b" | "env-host" {
  const value = process.env.SANDBOX_PROVIDER ?? "e2b";
  if (value === "e2b" || value === "env-host") return value;
  throw new Error('SANDBOX_PROVIDER must be "e2b" or "env-host"');
}

export function getSandboxProvider(): SandboxProvider {
  return sandboxProviderName() === "env-host" ? new EnvHostProvider() : new E2BProvider();
}

const MAX_BACKUP_BYTES = 8_000_000;

/** Environment of a sandbox created by sessions.start. The office inside it allows its E2B host only when this is set. */
export function sandboxProcessEnv(): Record<string, string> {
  return { E2B_SANDBOX: "1" };
}

function e2bCreateOpts() {
  return {
    apiKey: e2bApiKey(),
    timeoutMs: sandboxTimeoutMs(),
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
    envs: sandboxProcessEnv(),
  };
}

const ARCHIVE_SCRIPT = `
set -eu
cd "$WORKSPACE_DIR"
rm -f /tmp/iteration1-backup.tgz
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files -z --cached --others --exclude-standard | tar --null -czf /tmp/iteration1-backup.tgz -T -
else
  tar -czf /tmp/iteration1-backup.tgz --exclude=node_modules --exclude=.git .
fi
test -s /tmp/iteration1-backup.tgz
`;

const RESTORE_SCRIPT = `
set -eu
mkdir -p "$WORKSPACE_DIR"
tar -xzf /tmp/iteration1-backup.tgz -C "$WORKSPACE_DIR"
`;

const PORT_PROBE = `
node -e "const n=require('net');const s=n.connect(Number(process.env.PREVIEW_PORT),'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),800)"
`;

function e2bApiKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) throw new Error("E2B_API_KEY must be set in the Convex environment");
  return key;
}

function isCommandResult(error: unknown): error is CommandResult & { exitCode: number } {
  return Boolean(
    error &&
      typeof error === "object" &&
      "exitCode" in error &&
      "stdout" in error &&
      "stderr" in error &&
      typeof error.exitCode === "number",
  );
}

function shell(script: string): string {
  return script.replace(/\r/g, "");
}

async function runIn(sandbox: Sandbox, cmd: string, opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number }): Promise<CommandResult> {
  try {
    const result = await sandbox.commands.run(shell(cmd), opts);
    return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
  } catch (error) {
    if (isCommandResult(error)) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.exitCode };
    }
    throw error;
  }
}

const CLONE_SCRIPT = `
set -eu
if ! command -v git >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y git
fi
if [ -n "\${GIT_TOKEN:-}" ]; then
  git config --global credential.helper store
  host=$(printf '%s\n' "$REPO_URL" | sed -E 's#https://([^/@]+)/.*#\\1#')
  printf 'protocol=https\nhost=%s\nusername=git\npassword=%s\n\n' "$host" "$GIT_TOKEN" | git credential approve
  export GIT_TERMINAL_PROMPT=0
fi
mkdir -p "$(dirname "$WORKSPACE_DIR")"
rm -rf "$WORKSPACE_DIR"
git clone "$REPO_URL" "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"
git checkout -B "$BRANCH"
git config user.email "agent@iteration1.local"
git config user.name "Iteration 1"
`;

export class E2BProvider implements SandboxProvider {
  readonly name = "e2b" as const;
  readonly workspaceDir = "/home/user/workspace";

  async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create(e2bCreateOpts());
    try {
      const result = await runIn(sandbox, CLONE_SCRIPT, {
        timeoutMs: 120_000,
        envs: {
          REPO_URL: input.repoCloneUrl,
          BRANCH: input.branch,
          GIT_TOKEN: input.token,
          WORKSPACE_DIR: this.workspaceDir,
        },
      });
      if (result.code !== 0) {
        throw new Error(result.stderr.slice(0, 500) || "git clone failed");
      }
      return { sandboxId: sandbox.sandboxId, url: `https://${sandbox.getHost(3000)}` };
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }

  async createEmpty(): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create(e2bCreateOpts());
    try {
      const result = await runIn(sandbox, 'mkdir -p "$WORKSPACE_DIR"', {
        timeoutMs: 30_000,
        envs: { WORKSPACE_DIR: this.workspaceDir },
      });
      if (result.code !== 0) {
        throw new Error(result.stderr.slice(0, 500) || "could not create the workspace");
      }
      return { sandboxId: sandbox.sandboxId, url: `https://${sandbox.getHost(3000)}` };
    } catch (error) {
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }

  private async connect(sandboxId: string): Promise<Sandbox> {
    return await Sandbox.connect(sandboxId, { apiKey: e2bApiKey() });
  }

  async exec(sandboxId: string, cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult> {
    const cwd = workspacePath(opts?.cwd ?? this.workspaceDir, this.workspaceDir, { allowRoot: true });
    return await runIn(await this.connect(sandboxId), cmd, {
      cwd,
      timeoutMs: opts?.timeoutMs ?? 60_000,
    });
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const resolved = workspacePath(path, this.workspaceDir);
    return await (await this.connect(sandboxId)).files.read(resolved);
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    const resolved = workspacePath(path, this.workspaceDir);
    await (await this.connect(sandboxId)).files.write(resolved, content);
  }

  async deleteFile(sandboxId: string, path: string): Promise<void> {
    const resolved = workspacePath(path, this.workspaceDir);
    const result = await runIn(await this.connect(sandboxId), 'rm -f -- "$FILE"', {
      timeoutMs: 30_000,
      envs: { FILE: resolved },
    });
    if (result.code !== 0) throw new Error(result.stderr.slice(0, 500) || "delete failed");
  }

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = await this.connect(sandboxId);
    await sandbox.kill();
  }

  async resume(sandboxId: string): Promise<SandboxHandle> {
    const sandbox = await Sandbox.connect(sandboxId, { apiKey: e2bApiKey(), timeoutMs: sandboxTimeoutMs() });
    return { sandboxId: sandbox.sandboxId, url: `https://${sandbox.getHost(3000)}` };
  }

  async pause(sandboxId: string): Promise<void> {
    await Sandbox.pause(sandboxId, { apiKey: e2bApiKey() });
  }

  async sandboxState(sandboxId: string): Promise<"running" | "paused" | "missing"> {
    try {
      const info = await Sandbox.getInfo(sandboxId, { apiKey: e2bApiKey() });
      return info.state === "paused" ? "paused" : "running";
    } catch {
      return "missing";
    }
  }

  async portOpen(sandboxId: string, port: number): Promise<boolean> {
    const result = await runIn(await this.connect(sandboxId), PORT_PROBE, {
      timeoutMs: 8_000,
      envs: { PREVIEW_PORT: String(port) },
    });
    return result.code === 0;
  }

  async archive(sandboxId: string): Promise<Uint8Array | null> {
    const sandbox = await this.connect(sandboxId);
    const result = await runIn(sandbox, ARCHIVE_SCRIPT, {
      timeoutMs: 60_000,
      envs: { WORKSPACE_DIR: this.workspaceDir },
    });
    if (result.code !== 0) return null;
    const bytes = await sandbox.files.read("/tmp/iteration1-backup.tgz", { format: "bytes" });
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BACKUP_BYTES) return null;
    return bytes;
  }

  async restore(sandboxId: string, archive: Uint8Array): Promise<void> {
    const sandbox = await this.connect(sandboxId);
    const buffer = new ArrayBuffer(archive.byteLength);
    new Uint8Array(buffer).set(archive);
    await sandbox.files.write("/tmp/iteration1-backup.tgz", buffer);
    const result = await runIn(sandbox, RESTORE_SCRIPT, {
      timeoutMs: 60_000,
      envs: { WORKSPACE_DIR: this.workspaceDir },
    });
    if (result.code !== 0) throw new Error(result.stderr.slice(0, 500) || "could not restore the project backup");
  }

  async setTimeout(sandboxId: string, timeoutMs: number): Promise<void> {
    const sandbox = await this.connect(sandboxId);
    await sandbox.setTimeout(timeoutMs);
  }

  async startPreview(sandboxId: string, input: PreviewInput): Promise<PreviewResult> {
    const sandbox = await this.connect(sandboxId);
    const cwd = this.workspaceDir;
    const npm = await runIn(sandbox, ENSURE_NPM, { cwd, timeoutMs: 120_000 });
    if (npm.code !== 0) {
      throw new Error(`${npm.stderr}\n${npm.stdout}`.trim().slice(0, 500) || `npm is not available in the sandbox (exit ${npm.code})`);
    }
    let command = input.command;
    let install: string | undefined;
    let serve: string | undefined;
    if (!command) {
      // No package.json (a plain HTML site, say) is served as static files rather than failing.
      const packageJson = await sandbox.files.read(`${cwd}/package.json`).catch(() => null);
      const detected = commandFromPackageJson(packageJson, input.port);
      command = detected.command;
      install = detected.install;
      serve = detected.serve;
    }
    if (install) {
      const installed = await runIn(sandbox, install, { cwd, timeoutMs: 180_000 });
      if (installed.code !== 0) {
        throw new Error(installed.stderr.slice(0, 500) || installed.stdout.slice(0, 500) || "npm install failed");
      }
    }
    const handle = await sandbox.commands.run(shell(serve ?? command), {
      background: true,
      cwd,
      timeoutMs: 0,
      envs: previewEnvs(input.port),
    });
    const ready = await runIn(sandbox, waitForPortScript(), {
      cwd,
      timeoutMs: 120_000,
      envs: { PREVIEW_PID: String(handle.pid), PREVIEW_PORT: String(input.port) },
    });
    if (ready.code !== 0) {
      const logs = `${ready.stderr}\n${handle.stderr}`.trim().slice(0, 500);
      await handle.kill().catch(() => undefined);
      throw new Error(logs || `port ${input.port} did not respond within 90s`);
    }
    await handle.disconnect().catch(() => undefined);
    return { previewUrl: `https://${sandbox.getHost(input.port)}`, command };
  }
}

const ENSURE_NPM = `
if ! command -v npm >/dev/null 2>&1; then
  curl -fsSL https://nodejs.org/dist/v22.21.0/node-v22.21.0-linux-x64.tar.gz -o /tmp/node.tar.gz
  sudo tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1
fi
npm --version
`;

function previewEnvs(port: number): Record<string, string> {
  return {
    ...sandboxProcessEnv(),
    HOST: "0.0.0.0",
    HOSTNAME: "0.0.0.0",
    PORT: String(port),
    __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".e2b.app",
  };
}

function waitForPortScript(): string {
  return `
pid="$PREVIEW_PID"
port="$PREVIEW_PORT"
probe() {
  node -e "const n=require('net');const s=n.connect(Number(process.argv[1]),'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),500)" "$1"
}
ok=0
end=$((SECONDS + 90))
while [ "$SECONDS" -lt "$end" ]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "preview process exited" >&2
    break
  fi
  if probe "$port"; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" = 1 ]; then
  echo port-open
else
  echo "port $port did not respond within 90s" >&2
  false
fi
`;
}

function envHostConfig(): { base: string; secret: string } {
  const base = process.env.ENV_HOST_URL?.replace(/\/$/, "");
  const secret = process.env.ENV_HOST_SECRET;
  if (!base || !secret) {
    throw new Error("ENV_HOST_URL and ENV_HOST_SECRET must be set when SANDBOX_PROVIDER=env-host");
  }
  return { base, secret };
}

function hostId(branch: string): string {
  const suffix = branch.slice(branch.lastIndexOf("/") + 1);
  if (/^[A-Za-z0-9]+$/.test(suffix)) return suffix;
  throw new Error(`branch ${branch} does not end in an alphanumeric id`);
}

export class EnvHostProvider implements SandboxProvider {
  readonly name = "env-host" as const;
  readonly workspaceDir = "/workspace";

  async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    const { base, secret } = envHostConfig();
    const id = hostId(input.branch);
    const response = await fetch(`${base}/envs`, {
      method: "POST",
      headers: { authorization: secret, "content-type": "application/json" },
      body: JSON.stringify({
        id,
        repoUrl: input.repoCloneUrl,
        branch: input.branch,
        ...(input.token ? { token: input.token } : {}),
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`env host ${response.status}: ${text.slice(0, 500)}`);
    const parsed: unknown = JSON.parse(text);
    const url = parsed && typeof parsed === "object" && "url" in parsed && typeof parsed.url === "string" ? parsed.url : "";
    if (!url) throw new Error(`env host returned no url: ${text.slice(0, 500)}`);
    return { sandboxId: id, url };
  }

  async createEmpty(): Promise<SandboxHandle> {
    throw new Error("an empty sandbox requires SANDBOX_PROVIDER=e2b");
  }

  private containerAuth(): { secret: string } {
    return { secret: envHostConfig().secret };
  }

  async exec(sandboxId: string, cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult> {
    const session = await this.lookup(sandboxId);
    const response = await fetch(`${session.url}/exec`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.containerAuth().secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        cmd,
        cwd: workspacePath(opts?.cwd ?? this.workspaceDir, this.workspaceDir, { allowRoot: true }),
        timeoutMs: opts?.timeoutMs ?? 60_000,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`env exec ${response.status}: ${text.slice(0, 500)}`);
    const parsed = JSON.parse(text) as { stdout?: unknown; stderr?: unknown; code?: unknown };
    if (typeof parsed.stdout !== "string" || typeof parsed.stderr !== "string" || typeof parsed.code !== "number") {
      throw new Error("env exec returned an unexpected body");
    }
    return { stdout: parsed.stdout, stderr: parsed.stderr, code: parsed.code };
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    const resolved = workspacePath(path, this.workspaceDir);
    const session = await this.lookup(sandboxId);
    const response = await fetch(`${session.url}/file?path=${encodeURIComponent(resolved)}`, {
      headers: { authorization: `Bearer ${this.containerAuth().secret}` },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`env read ${response.status}: ${text.slice(0, 500)}`);
    const parsed = JSON.parse(text) as { content?: unknown };
    if (typeof parsed.content !== "string") throw new Error("env read returned no content");
    return parsed.content;
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    const resolved = workspacePath(path, this.workspaceDir);
    const session = await this.lookup(sandboxId);
    const response = await fetch(`${session.url}/file`, {
      method: "PUT",
      headers: { authorization: `Bearer ${this.containerAuth().secret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: resolved, content }),
    });
    if (!response.ok) throw new Error(`env write ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  async deleteFile(sandboxId: string, path: string): Promise<void> {
    const resolved = workspacePath(path, this.workspaceDir);
    const session = await this.lookup(sandboxId);
    const response = await fetch(`${session.url}/file`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.containerAuth().secret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: resolved }),
    });
    if (!response.ok) throw new Error(`env delete ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  async destroy(sandboxId: string): Promise<void> {
    const { base, secret } = envHostConfig();
    const response = await fetch(`${base}/envs/${sandboxId}`, { method: "DELETE", headers: { authorization: secret } });
    if (!response.ok) throw new Error(`env destroy ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }

  async setTimeout(): Promise<void> {
    return;
  }

  async startPreview(): Promise<PreviewResult> {
    throw new Error("live preview requires SANDBOX_PROVIDER=e2b");
  }

  async resume(): Promise<SandboxHandle> {
    throw new Error("resuming a sandbox requires SANDBOX_PROVIDER=e2b");
  }

  async pause(): Promise<void> {
    throw new Error("pausing a sandbox requires SANDBOX_PROVIDER=e2b");
  }

  async portOpen(): Promise<boolean> {
    return false;
  }

  async archive(): Promise<Uint8Array | null> {
    return null;
  }

  async restore(): Promise<void> {
    throw new Error("restoring a sandbox requires SANDBOX_PROVIDER=e2b");
  }

  async sandboxState(): Promise<"running" | "paused" | "missing"> {
    return "missing";
  }

  private async lookup(sandboxId: string): Promise<{ url: string }> {
    const { base, secret } = envHostConfig();
    const response = await fetch(`${base}/envs`, { headers: { authorization: secret } });
    const text = await response.text();
    if (!response.ok) throw new Error(`env list ${response.status}: ${text.slice(0, 500)}`);
    const parsed = JSON.parse(text) as { envs?: Array<{ id?: string; url?: string }> };
    const match = parsed.envs?.find((env) => env.id === sandboxId && typeof env.url === "string");
    if (!match?.url) throw new Error(`env ${sandboxId} is not running`);
    return { url: match.url };
  }
}
