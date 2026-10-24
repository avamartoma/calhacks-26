import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { recordEvent } from "./events";
import { currentUser, LOCAL_USER_ID, type OfficeUser } from "./identity";
import { assertNonEmpty } from "./validators";

const LEASE_MS = 5 * 60 * 1000;
const EXEC_TIMEOUT_MS = 60_000;
const LIST_FILES_GIT = "git ls-files -z --cached --others --exclude-standard";
const LIST_FILES_FIND = "find . \\( -name node_modules -o -name .git \\) -prune -o -type f -print0";

const toolValidator = v.union(
  v.literal("list_files"),
  v.literal("read_file"),
  v.literal("write_file"),
  v.literal("delete_file"),
  v.literal("run_command"),
  v.literal("get_preview_url"),
);

type AgentTool = "list_files" | "read_file" | "write_file" | "delete_file" | "run_command" | "get_preview_url";

type GatewayResult =
  | { tool: "list_files"; paths: string[] }
  | { tool: "read_file"; content: string }
  | { tool: "write_file"; ok: true }
  | { tool: "delete_file"; ok: true }
  | { tool: "run_command"; stdout: string; stderr: string; code: number }
  | { tool: "get_preview_url"; previewUrl: string | null };

type DbCtx = QueryCtx | MutationCtx;

const EDITOR_TOOLS = new Set<AgentTool>(["write_file", "delete_file", "run_command"]);

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentHash(content: string): string {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(16)}:${content.length}`;
}

/** Owner check used when issuing. The unsigned office user is `local`. */
function callerOwns(user: OfficeUser, ownerId: string): boolean {
  return ownerId === user.id || (user.local && ownerId === LOCAL_USER_ID);
}

async function memberRoles(ctx: DbCtx, projectId: Id<"projects">, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .query("members")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return rows.filter((row) => row.userId === userId).map((row) => row.role);
}

function canEdit(owner: boolean, roles: string[]): boolean {
  return owner || roles.some((role) => role === "owner" || role === "editor");
}

function canView(owner: boolean, roles: string[], visibility: Doc<"projects">["visibility"]): boolean {
  return owner || visibility === "public" || roles.some((role) => role === "owner" || role === "editor" || role === "viewer");
}

function listedPaths(stdout: string): string[] {
  const raw = stdout.includes("\0") ? stdout.split("\0") : stdout.split(/\r?\n/);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const part of raw) {
    let path = part.replace(/\\/g, "/").trim();
    if (path.startsWith("./")) path = path.slice(2);
    if (!path || path === "." || path.startsWith("/")) continue;
    const segments = path.split("/");
    if (segments.includes("..") || segments.includes("node_modules") || segments.includes(".git")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  paths.sort((a, b) => a.localeCompare(b));
  return paths;
}

export const issue = mutation({
  args: {
    projectId: v.id("projects"),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error(`Project ${args.projectId} not found`);
    }
    const roles = await memberRoles(ctx, args.projectId, user.id);
    if (!canEdit(callerOwns(user, project.ownerId), roles)) {
      throw new Error("Only a project owner or editor can connect an agent");
    }
    const label = args.label?.trim();
    if (label && label.length > 80) {
      throw new Error("label must be 80 characters or fewer");
    }
    const token = randomToken();
    const hashedToken = await sha256Hex(token);
    const tokenId = await ctx.db.insert("tokens", {
      userId: user.id,
      projectId: args.projectId,
      hashedToken,
      ...(label ? { label } : {}),
      createdAt: Date.now(),
    });
    return { tokenId, token };
  },
});

export const revoke = mutation({
  args: { tokenId: v.id("tokens") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const token = await ctx.db.get(args.tokenId);
    if (!token || token.userId !== user.id) {
      throw new Error("Token not found");
    }
    if (token.revokedAt === undefined) {
      await ctx.db.patch(token._id, { revokedAt: Date.now() });
    }
    return { ok: true as const };
  },
});

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const rows = await ctx.db
      .query("tokens")
      .withIndex("by_user", (q) => q.eq("userId", user.id))
      .collect();
    return rows
      .filter((row) => row.projectId === args.projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({
        id: row._id,
        label: row.label ?? null,
        createdAt: row.createdAt,
        revokedAt: row.revokedAt ?? null,
      }));
  },
});

export const authorizeToken = internalQuery({
  args: {
    hashedToken: v.string(),
    projectId: v.id("projects"),
    level: v.union(v.literal("viewer"), v.literal("editor")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tokens")
      .withIndex("by_hash", (q) => q.eq("hashedToken", args.hashedToken))
      .unique();
    if (!row) {
      throw new Error("Unknown token");
    }
    if (row.revokedAt !== undefined) {
      throw new Error("Token revoked");
    }
    if (row.projectId !== args.projectId) {
      throw new Error("Token is for a different project");
    }
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error(`Project ${args.projectId} not found`);
    }
    const owner = project.ownerId === row.userId;
    const roles = await memberRoles(ctx, args.projectId, row.userId);
    const allowed = args.level === "editor" ? canEdit(owner, roles) : canView(owner, roles, project.visibility);
    if (!allowed) {
      throw new Error(args.level === "editor" ? "Not allowed to edit this project" : "Not allowed to view this project");
    }
    return { userId: row.userId };
  },
});

/** A ready sandbox session for this project, preferring the project's current sandbox. */
export const readySession = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const ready = sessions.filter((session) => session.status === "ready" && !!session.sandboxId);
    if (ready.length === 0) return null;
    const matched = project.sandboxId ? ready.find((session) => session.sandboxId === project.sandboxId) : undefined;
    const chosen = matched ?? ready.reduce((best, session) => (session.lastActiveAt > best.lastActiveAt ? session : best));
    return { sessionId: chosen._id };
  },
});

/**
 * Same lease rule as `leases.acquire`: one path, five minutes, the same session renews.
 * A different session with an unexpired lease is rejected.
 */
export const acquireLease = internalMutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const path = assertNonEmpty(args.path, "path");
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error(`Project ${args.projectId} not found`);
    }
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error(`Session ${args.sessionId} not found`);
    }
    if (session.projectId !== args.projectId) {
      throw new Error(`Session ${args.sessionId} is not on project ${args.projectId}`);
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("leases")
      .withIndex("by_project_path", (q) => q.eq("projectId", args.projectId).eq("path", path))
      .unique();
    if (existing && existing.expiresAt > now && existing.sessionId !== args.sessionId) {
      throw new Error("File is busy");
    }
    const expiresAt = now + LEASE_MS;
    if (existing) {
      await ctx.db.patch(existing._id, { sessionId: args.sessionId, expiresAt });
      await recordEvent(ctx, {
        projectId: args.projectId,
        sessionId: args.sessionId,
        kind: existing.sessionId === args.sessionId ? "lease.renewed" : "lease.acquired",
        detail: path,
      });
      return { ok: true as const };
    }
    await ctx.db.insert("leases", {
      projectId: args.projectId,
      path,
      sessionId: args.sessionId,
      expiresAt,
    });
    await recordEvent(ctx, {
      projectId: args.projectId,
      sessionId: args.sessionId,
      kind: "lease.acquired",
      detail: path,
    });
    return { ok: true as const };
  },
});

export const gateway = action({
  args: {
    token: v.string(),
    projectId: v.id("projects"),
    tool: toolValidator,
    path: v.optional(v.string()),
    content: v.optional(v.string()),
    command: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<GatewayResult> => {
    if (args.token.length === 0 || args.token.length > 256) {
      throw new Error("Unknown token");
    }
    const hashedToken = await sha256Hex(args.token);
    await ctx.runQuery(internal.agentTokens.authorizeToken, {
      hashedToken,
      projectId: args.projectId,
      level: EDITOR_TOOLS.has(args.tool) ? "editor" : "viewer",
    });
    const ready = await ctx.runQuery(internal.agentTokens.readySession, { projectId: args.projectId });
    if (!ready) {
      throw new Error("Open the project so its sandbox is running");
    }
    const info = await ctx.runQuery(internal.sessions.getInternal, { sessionId: ready.sessionId });
    if (!info || info.status !== "ready" || !info.sandboxId) {
      throw new Error("Open the project so its sandbox is running");
    }
    const sandboxId = info.sandboxId;
    const sessionId = ready.sessionId;
    await ctx.runMutation(internal.sessions.touch, { sessionId });

    if (args.tool === "list_files") {
      const git: { stdout: string; stderr: string; code: number } = await ctx.runAction(internal.sessionSandbox.exec, {
        sandboxId,
        cmd: LIST_FILES_GIT,
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      if (git.code === 0) {
        return { tool: "list_files", paths: listedPaths(git.stdout) };
      }
      const found: { stdout: string; stderr: string; code: number } = await ctx.runAction(internal.sessionSandbox.exec, {
        sandboxId,
        cmd: LIST_FILES_FIND,
        timeoutMs: EXEC_TIMEOUT_MS,
      });
      if (found.code !== 0) {
        throw new Error(found.stderr.slice(0, 300) || "Could not list files");
      }
      return { tool: "list_files", paths: listedPaths(found.stdout) };
    }

    if (args.tool === "read_file") {
      const path = assertNonEmpty(args.path ?? "", "path");
      const file: { content: string } = await ctx.runAction(internal.sessionSandbox.readFile, { sandboxId, path });
      return { tool: "read_file", content: file.content };
    }

    if (args.tool === "get_preview_url") {
      return { tool: "get_preview_url", previewUrl: info.previewUrl };
    }

    if (args.tool === "write_file") {
      const path = assertNonEmpty(args.path ?? "", "path");
      if (args.content === undefined) {
        throw new Error("content is required");
      }
      await ctx.runMutation(internal.agentTokens.acquireLease, { projectId: args.projectId, path, sessionId });
      await ctx.runAction(internal.sessionSandbox.writeFile, { sandboxId, path, content: args.content });
      await ctx.runMutation(internal.fileChanges.record, {
        sessionId,
        path,
        op: "write",
        contentHash: contentHash(args.content),
      });
      await ctx.runMutation(internal.sessions.recordSessionEvent, {
        sessionId,
        kind: "session.write_file",
        detail: path,
      });
      return { tool: "write_file", ok: true };
    }

    if (args.tool === "delete_file") {
      const path = assertNonEmpty(args.path ?? "", "path");
      await ctx.runMutation(internal.agentTokens.acquireLease, { projectId: args.projectId, path, sessionId });
      await ctx.runAction(internal.sessionSandbox.deleteFile, { sandboxId, path });
      await ctx.runMutation(internal.fileChanges.record, {
        sessionId,
        path,
        op: "delete",
        contentHash: "delete",
      });
      await ctx.runMutation(internal.sessions.recordSessionEvent, {
        sessionId,
        kind: "session.delete_file",
        detail: path,
      });
      return { tool: "delete_file", ok: true };
    }

    const command = assertNonEmpty(args.command ?? "", "command");
    const result: { stdout: string; stderr: string; code: number } = await ctx.runAction(internal.sessionSandbox.exec, {
      sandboxId,
      cmd: command,
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    await ctx.runMutation(internal.sessions.recordSessionEvent, {
      sessionId,
      kind: "session.exec",
      detail: `exited ${result.code}: ${command.slice(0, 200)}`,
    });
    return { tool: "run_command", stdout: result.stdout, stderr: result.stderr, code: result.code };
  },
});
