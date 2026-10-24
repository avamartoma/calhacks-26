import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { recordEvent } from "./events";
import { assertNonEmpty } from "./validators";

const LEASE_MS = 5 * 60 * 1000;

export const acquire = mutation({
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
      return { ok: false as const, heldBy: existing.sessionId };
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

export const release = mutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    sessionId: v.id("sessions"),
  },
  handler: async (ctx, args) => {
    const path = assertNonEmpty(args.path, "path");
    const existing = await ctx.db
      .query("leases")
      .withIndex("by_project_path", (q) => q.eq("projectId", args.projectId).eq("path", path))
      .unique();
    if (!existing) {
      throw new Error(`No lease for ${path}`);
    }
    if (existing.sessionId !== args.sessionId && existing.expiresAt > Date.now()) {
      throw new Error(`Lease for ${path} is held by ${existing.sessionId}`);
    }
    await ctx.db.delete(existing._id);
    await recordEvent(ctx, {
      projectId: args.projectId,
      sessionId: args.sessionId,
      kind: "lease.released",
      detail: path,
    });
    return { ok: true as const };
  },
});

export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const leases = await ctx.db.query("leases").collect();
    let removed = 0;
    for (const lease of leases) {
      if (lease.expiresAt > now) {
        continue;
      }
      await ctx.db.delete(lease._id);
      await recordEvent(ctx, {
        projectId: lease.projectId,
        sessionId: lease.sessionId,
        kind: "lease.expired",
        detail: lease.path,
      });
      removed += 1;
    }
    return { removed };
  },
});
