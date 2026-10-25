import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAccess } from "./access";
import { currentUser } from "./identity";
import { publicWorkspace } from "./workspaces";
import { inviteLink, revokeInvites } from "./shareLinks";
import { accessRoleValidator, assertNonEmpty } from "./validators";

declare const process: { env: Record<string, string | undefined> };

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

const INVITES_PER_DAY = 30;

/** Whether invites send an email, so the Share panel can say so. */
export const emailEnabled = query({
  args: {},
  handler: async () => !!process.env.GMAIL_USER && !!process.env.GMAIL_APP_PASSWORD,
});

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

/**
 * Public means in the public workspace, so making a project public moves it there, and making
 * it private moves it back to the owner's first personal workspace.
 */
export const setVisibility = mutation({
  args: {
    projectId: v.id("projects"),
    visibility: v.union(v.literal("private"), v.literal("public")),
  },
  handler: async (ctx, args) => {
    const { project } = await requireOwner(ctx, args.projectId);
    const everyone = await publicWorkspace(ctx);
    const leavingPublic = args.visibility === "private" && everyone && project.workspaceId === everyone._id;
    await ctx.db.patch(args.projectId, {
      visibility: args.visibility,
      ...(args.visibility === "public" && everyone ? { workspaceId: everyone._id } : {}),
      ...(leavingPublic ? { workspaceId: undefined } : {}),
    });
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
    const { project, user } = await requireOwner(ctx, args.projectId);
    const email = normalizeEmail(args.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("That isn't an email address");
    const existing = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_email", (q) => q.eq("projectId", args.projectId).eq("email", email))
      .unique();
    let id;
    if (existing) {
      await ctx.db.patch(existing._id, { role: args.role, invitedBy: user.id });
      id = existing._id;
    } else {
      // Each invite can send an email from the team's account, so keep it to a reasonable number a day.
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const recent = await ctx.db.query("projectAccess").filter((q) => q.and(q.eq(q.field("invitedBy"), user.id), q.gt(q.field("_creationTime"), since))).collect();
      if (!user.local && recent.length >= INVITES_PER_DAY) throw new Error(`You can invite up to ${INVITES_PER_DAY} people a day.`);
      id = await ctx.db.insert("projectAccess", { projectId: args.projectId, email, role: args.role, invitedBy: user.id });
    }
    if (email !== user.email) {
      // The email's own link works whichever account they sign in with, not only this address.
      const token = await inviteLink(ctx, args.projectId, email, args.role, user.id);
      await ctx.scheduler.runAfter(0, internal.inviteEmail.send, {
        email, role: args.role, project: project.name, projectId: args.projectId, token,
        inviter: user.name || user.email || "Someone", ...(user.email ? { inviterEmail: user.email } : {}),
      });
    }
    return id;
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
    await revokeInvites(ctx, args.projectId, email);
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
