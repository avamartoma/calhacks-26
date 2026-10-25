import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { currentUser } from "./identity";
import { accessRoleValidator } from "./validators";

// Share links: open one while signed in and you get view or edit access to that project. Owners
// have one reusable view link and one edit link, which they can turn off; turning one off also
// takes away the access it gave. Invite emails carry their own one-time link (see sharing.invite).

type Role = "viewer" | "editor";
const RANK: Record<Role, number> = { viewer: 0, editor: 1 };

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ownerOf(ctx: QueryCtx | MutationCtx, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (!project) throw new Error("Project not found");
  const user = await currentUser(ctx);
  if (project.ownerId !== user.id) throw new Error("Only the project owner can do this");
  return { project, user };
}

const activeLinks = async (ctx: QueryCtx | MutationCtx, projectId: Id<"projects">) =>
  (await ctx.db.query("shareLinks").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()).filter((link) => link.kind === "link" && !link.revokedAt);

/** Turns a link off and takes away the access people got through it. */
export async function revokeLink(ctx: MutationCtx, link: Doc<"shareLinks">) {
  if (!link.revokedAt) await ctx.db.patch(link._id, { revokedAt: Date.now() });
  for (const grant of await ctx.db.query("linkGrants").withIndex("by_link", (q) => q.eq("linkId", link._id)).collect()) await ctx.db.delete(grant._id);
}

/** A one-time link for an invite email. Replaces any earlier unused one for the same address. */
export async function inviteLink(ctx: MutationCtx, projectId: Id<"projects">, email: string, role: Role, createdBy: string) {
  const old = (await ctx.db.query("shareLinks").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()).filter((link) => link.kind === "invite" && link.email === email && !link.revokedAt);
  for (const link of old) {
    if (link.usedBy) {
      // Already accepted: keep their access in step with the new role.
      for (const grant of await ctx.db.query("linkGrants").withIndex("by_link", (q) => q.eq("linkId", link._id)).collect()) await ctx.db.patch(grant._id, { role });
      await ctx.db.patch(link._id, { role });
    } else {
      await ctx.db.patch(link._id, { revokedAt: Date.now() });
    }
  }
  const token = newToken();
  await ctx.db.insert("shareLinks", { projectId, token, role, kind: "invite", email, createdBy });
  return token;
}

/** Removing someone's invite also removes access they got through its email link. */
export async function revokeInvites(ctx: MutationCtx, projectId: Id<"projects">, email: string) {
  const links = (await ctx.db.query("shareLinks").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()).filter((link) => link.kind === "invite" && link.email === email);
  for (const link of links) await revokeLink(ctx, link);
}

/** The owner's view and edit links, if they're on. */
export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await ownerOf(ctx, args.projectId);
    const links = await activeLinks(ctx, args.projectId);
    const joined = async (link: Doc<"shareLinks">) => (await ctx.db.query("linkGrants").withIndex("by_link", (q) => q.eq("linkId", link._id)).collect()).length;
    const pick = async (role: Role) => { const link = links.find((item) => item.role === role); return link ? { token: link.token, joined: await joined(link) } : null; };
    return { viewer: await pick("viewer"), editor: await pick("editor") };
  },
});

/** Turns on the view or edit link, or returns it if it's already on. */
export const create = mutation({
  args: { projectId: v.id("projects"), role: accessRoleValidator },
  handler: async (ctx, args) => {
    const { user } = await ownerOf(ctx, args.projectId);
    const existing = (await activeLinks(ctx, args.projectId)).find((link) => link.role === args.role);
    if (existing) return existing.token;
    const token = newToken();
    await ctx.db.insert("shareLinks", { projectId: args.projectId, token, role: args.role, kind: "link", createdBy: user.id });
    return token;
  },
});

export const revoke = mutation({
  args: { projectId: v.id("projects"), role: accessRoleValidator },
  handler: async (ctx, args) => {
    await ownerOf(ctx, args.projectId);
    for (const link of (await activeLinks(ctx, args.projectId)).filter((item) => item.role === args.role)) await revokeLink(ctx, link);
    return { ok: true as const };
  },
});

/** What a link is for, shown before accepting it. Anyone may ask, so it says no more than that. */
export const preview = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.query("shareLinks").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
    const project = link ? await ctx.db.get(link.projectId) : null;
    if (!link || !project) return { valid: false as const, reason: "This link doesn't exist." };
    if (link.revokedAt) return { valid: false as const, reason: "The owner turned this link off." };
    const user = await currentUser(ctx);
    if (link.kind === "invite" && link.usedBy && link.usedBy !== user.id) return { valid: false as const, reason: "This invite was already used by someone else. Ask the owner for a new one." };
    return { valid: true as const, projectId: project._id, project: project.name, role: link.role, kind: link.kind };
  },
});

/** Accepts a link for the signed-in person and returns the project to open. */
export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (user.local) throw new Error("Sign in to open this link");
    const link = await ctx.db.query("shareLinks").withIndex("by_token", (q) => q.eq("token", args.token)).unique();
    if (!link || link.revokedAt) throw new Error("This link has been turned off or doesn't exist");
    const project = await ctx.db.get(link.projectId);
    if (!project) throw new Error("Project not found");
    if (project.ownerId === user.id) return { projectId: project._id };
    if (link.kind === "invite") {
      if (link.usedBy && link.usedBy !== user.id) throw new Error("This invite was already used by someone else. Ask the owner for a new one.");
      if (!link.usedBy) await ctx.db.patch(link._id, { usedBy: user.id });
    }
    const existing = await ctx.db.query("linkGrants").withIndex("by_project_user", (q) => q.eq("projectId", project._id).eq("userId", user.id)).collect();
    const same = existing.find((grant) => grant.linkId === link._id);
    if (same) {
      if (RANK[link.role] > RANK[same.role]) await ctx.db.patch(same._id, { role: link.role });
    } else {
      await ctx.db.insert("linkGrants", { projectId: project._id, userId: user.id, role: link.role, linkId: link._id });
    }
    return { projectId: project._id };
  },
});
