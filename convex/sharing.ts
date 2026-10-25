import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAccess } from "./access";
import { currentUser } from "./identity";
import { accessRoleValidator, assertNonEmpty } from "./validators";

type OwnerCtx = QueryCtx | MutationCtx;

async function requireOwner(ctx: OwnerCtx, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  const user = await currentUser(ctx);
  // Unsigned callers are id "local", so the local owner of a local project still matches.
  if (project.ownerId !== user.id) {
    throw new Error("Only the project owner can do this");
  }
  return { project, user };
}

function normalizeEmail(email: string): string {
  return assertNonEmpty(email, "email").toLowerCase();
}

export const get = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    let project = await ctx.db
      .query("projects")
      .withIndex("by_share_slug", (q) => q.eq("shareSlug", args.slug))
      .unique();
    if (!project) {
      project = await ctx.db
        .query("projects")
        .withIndex("by_slug", (q) => q.eq("slug", args.slug))
        .unique();
    }
    if (!project) {
      throw new Error("Project not found");
    }
    const role = await requireAccess(ctx, project._id, "viewer");
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    let newest: (typeof sessions)[number] | null = null;
    for (const session of sessions) {
      if (!newest || session._creationTime > newest._creationTime) {
        newest = session;
      }
    }
    const snapshotUrl = project.lastSnapshot ? await ctx.storage.getUrl(project.lastSnapshot) : null;
    return {
      projectId: project._id,
      name: project.name,
      visibility: project.visibility,
      shareSlug: project.shareSlug ?? project.slug,
      role,
      previewUrl: newest?.previewUrl ?? null,
      previewStatus: newest?.previewStatus ?? null,
      snapshotUrl,
    };
  },
});

export const setVisibility = mutation({
  args: {
    projectId: v.id("projects"),
    visibility: v.union(v.literal("private"), v.literal("public")),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.projectId);
    await ctx.db.patch(args.projectId, { visibility: args.visibility });
    return args.projectId;
  },
});

export const invite = mutation({
  args: {
    projectId: v.id("projects"),
    email: v.string(),
    role: accessRoleValidator,
  },
  handler: async (ctx, args) => {
    const { user } = await requireOwner(ctx, args.projectId);
    const email = normalizeEmail(args.email);
    const existing = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_email", (q) => q.eq("projectId", args.projectId).eq("email", email))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { role: args.role, invitedBy: user.id });
      return existing._id;
    }
    return await ctx.db.insert("projectAccess", {
      projectId: args.projectId,
      email,
      role: args.role,
      invitedBy: user.id,
    });
  },
});

export const remove = mutation({
  args: {
    projectId: v.id("projects"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.projectId);
    const email = normalizeEmail(args.email);
    const existing = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_email", (q) => q.eq("projectId", args.projectId).eq("email", email))
      .unique();
    if (!existing) {
      throw new Error("Invite not found");
    }
    await ctx.db.delete(existing._id);
    return { ok: true as const };
  },
});

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.projectId);
    return await ctx.db
      .query("projectAccess")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});
