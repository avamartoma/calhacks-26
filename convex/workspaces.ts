import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAccess } from "./access";
import { currentUser } from "./identity";

// The same rules as the local office's workspaces (server/workspaces.mjs).
export const SKY_PALETTE = ["#8fb6d8", "#c4a6d4", "#8fd0c0", "#e0b48a", "#b9c48f", "#d8a0a8"];
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function cleanName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) throw new Error("Name a workspace in 1 to 60 characters");
  return trimmed;
}

function cleanImage(image: string) {
  if (image.length > 60000 || !IMAGE.test(image)) throw new Error("Use a small PNG, JPEG or WebP image");
  return image;
}

async function owned(ctx: QueryCtx, ownerId: string) {
  const rows = await ctx.db.query("workspaces").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect();
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/** The workspace a project of yours sits in: its own, or your first one. */
export function workspaceOf(project: Doc<"projects">, workspaces: Doc<"workspaces">[]): Id<"workspaces"> | null {
  if (project.workspaceId && workspaces.some((workspace) => workspace._id === project.workspaceId)) return project.workspaceId;
  return workspaces[0]?._id ?? null;
}

async function mine(ctx: MutationCtx, id: Id<"workspaces">) {
  const user = await currentUser(ctx);
  const workspace = await ctx.db.get(id);
  if (!workspace || workspace.ownerId !== user.id) throw new Error("Workspace not found");
  return { user, workspace };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    return (await owned(ctx, user.id)).map((workspace) => ({ id: workspace._id, name: workspace.name, color: workspace.color, image: workspace.image, createdAt: workspace.createdAt }));
  },
});

/** Everyone starts with one workspace, made the first time their sky opens. */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const existing = await owned(ctx, user.id);
    if (existing.length) return existing[0]._id;
    return await ctx.db.insert("workspaces", { ownerId: user.id, name: "My workspace", color: SKY_PALETTE[0], createdAt: Date.now() });
  },
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const existing = await owned(ctx, user.id);
    return await ctx.db.insert("workspaces", { ownerId: user.id, name: cleanName(args.name), color: SKY_PALETTE[existing.length % SKY_PALETTE.length], createdAt: Date.now() });
  },
});

export const update = mutation({
  args: { id: v.id("workspaces"), name: v.optional(v.string()), image: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const { workspace } = await mine(ctx, args.id);
    await ctx.db.patch(workspace._id, {
      ...(args.name !== undefined ? { name: cleanName(args.name) } : {}),
      ...(args.image === null ? { image: undefined } : args.image !== undefined ? { image: cleanImage(args.image) } : {}),
    });
  },
});

/** Removing a workspace moves its projects into another one; the last workspace stays. */
export const remove = mutation({
  args: { id: v.id("workspaces") },
  handler: async (ctx, args) => {
    const { user, workspace } = await mine(ctx, args.id);
    const all = await owned(ctx, user.id);
    if (all.length === 1) throw new Error("This is the only workspace. Create another before removing this one.");
    const moveTo = all.find((other) => other._id !== workspace._id)!;
    const projects = await ctx.db.query("projects").collect();
    let moved = 0;
    for (const project of projects) {
      if (project.ownerId === user.id && workspaceOf(project, all) === workspace._id) {
        await ctx.db.patch(project._id, { workspaceId: moveTo._id });
        moved += 1;
      }
    }
    await ctx.db.delete(workspace._id);
    return { movedTo: moveTo._id, moved };
  },
});

/** Puts one of your projects in one of your workspaces. */
export const moveProject = mutation({
  args: { projectId: v.id("projects"), workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const { user } = await mine(ctx, args.workspaceId);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.ownerId !== user.id) throw new Error("Only the project's owner can move it");
    await ctx.db.patch(project._id, { workspaceId: args.workspaceId });
  },
});

/** Remembers where you dragged a cloud on your sky. */
export const place = mutation({
  args: { projectId: v.id("projects"), x: v.number(), y: v.number() },
  handler: async (ctx, args) => {
    await requireAccess(ctx, args.projectId, "viewer");
    if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || Math.abs(args.x) > 1e6 || Math.abs(args.y) > 1e6) throw new Error("That spot is off the sky");
    const user = await currentUser(ctx);
    const row = await ctx.db.query("skyPositions").withIndex("by_user_project", (q) => q.eq("userId", user.id).eq("projectId", args.projectId)).unique();
    if (row) await ctx.db.patch(row._id, { x: args.x, y: args.y });
    else await ctx.db.insert("skyPositions", { userId: user.id, projectId: args.projectId, x: args.x, y: args.y });
  },
});
