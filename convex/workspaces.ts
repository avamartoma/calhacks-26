import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAccess, workspaceRole, type WorkspaceRole } from "./access";
import { currentUser, type OfficeUser } from "./identity";

// The same rules as the local office's workspaces (server/workspaces.mjs), plus sharing: a
// personal workspace is its owner's alone, a shared one has members invited by email, and the
// one public workspace is everyone's.
export const SKY_PALETTE = ["#8fb6d8", "#c4a6d4", "#8fd0c0", "#e0b48a", "#b9c48f", "#d8a0a8"];
const PUBLIC_OWNER = "public";
const PUBLIC_COLOR = "#5b8fd6";
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roleValidator = v.union(v.literal("viewer"), v.literal("editor"));

function cleanName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 60) throw new Error("Name a workspace in 1 to 60 characters");
  return trimmed;
}

function cleanImage(image: string) {
  if (image.length > 60000 || !IMAGE.test(image)) throw new Error("Use a small PNG, JPEG or WebP image");
  return image;
}

function cleanEmail(email: string) {
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL.test(trimmed)) throw new Error(`${email.trim() || "That"} isn't an email address`);
  return trimmed;
}

const kindOf = (workspace: Doc<"workspaces">) => workspace.kind ?? "personal";

async function owned(ctx: QueryCtx, ownerId: string) {
  const rows = await ctx.db.query("workspaces").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).collect();
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/** The caller's own personal workspaces, oldest first. A project with no workspace sits in the first. */
async function personal(ctx: QueryCtx, ownerId: string) {
  return (await owned(ctx, ownerId)).filter((workspace) => kindOf(workspace) === "personal");
}

export async function publicWorkspace(ctx: QueryCtx) {
  return await ctx.db.query("workspaces").withIndex("by_kind", (q) => q.eq("kind", "public")).first();
}

/**
 * The workspace a project shows in for this caller: its own when the caller can see that
 * workspace, otherwise (for their own projects) their first personal one. Null means it was
 * shared with them directly, so it shows behind their personal skies.
 */
export async function workspaceFor(ctx: QueryCtx, project: Doc<"projects">, user: OfficeUser, mine: Doc<"workspaces">[]): Promise<Id<"workspaces"> | null> {
  const workspace = project.workspaceId ? await ctx.db.get(project.workspaceId) : null;
  if (workspace && (await workspaceRole(ctx, workspace, user))) return workspace._id;
  return project.ownerId === user.id ? mine[0]?._id ?? null : null;
}

/** Who may do what in a workspace. */
function abilities(workspace: Doc<"workspaces">, role: WorkspaceRole) {
  const kind = kindOf(workspace);
  const admin = role === "admin";
  return {
    admin,
    // Anyone can put their projects in Public; in a shared workspace members need the creator's permission.
    canAddProjects: kind === "public" || admin || (kind === "shared" && !!workspace.allowMemberProjects),
    canInvite: kind === "shared" && (admin || !!workspace.allowMemberInvites),
  };
}

async function requireRole(ctx: QueryCtx, id: Id<"workspaces">, user: OfficeUser) {
  const workspace = await ctx.db.get(id);
  const role = workspace ? await workspaceRole(ctx, workspace, user) : null;
  if (!workspace || !role) throw new Error("Workspace not found");
  return { workspace, role, ...abilities(workspace, role) };
}

async function requireAdmin(ctx: QueryCtx, id: Id<"workspaces">, user: OfficeUser) {
  const found = await requireRole(ctx, id, user);
  if (!found.admin) throw new Error("Only the workspace's creator can do that");
  return found;
}

/** Your workspaces: Public first, then your own, then shared ones you were invited to. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const rows: Doc<"workspaces">[] = [];
    const everyone = await publicWorkspace(ctx);
    if (everyone && !user.local) rows.push(everyone);
    rows.push(...(await owned(ctx, user.id)));
    if (user.email) {
      const memberships = await ctx.db.query("workspaceMembers").withIndex("by_email", (q) => q.eq("email", user.email!)).collect();
      for (const membership of memberships) {
        const workspace = await ctx.db.get(membership.workspaceId);
        if (workspace && !rows.some((row) => row._id === workspace._id)) rows.push(workspace);
      }
    }
    const result = [];
    for (const workspace of rows) {
      const role = await workspaceRole(ctx, workspace, user);
      if (!role) continue;
      result.push({
        id: workspace._id, name: workspace.name, color: workspace.color, image: workspace.image, createdAt: workspace.createdAt,
        kind: kindOf(workspace), role, owner: workspace.ownerEmail ?? null,
        allowMemberProjects: !!workspace.allowMemberProjects, allowMemberInvites: !!workspace.allowMemberInvites,
        ...abilities(workspace, role),
      });
    }
    return result;
  },
});

/** Everyone starts with one personal workspace, made the first time their sky opens, and there is one public workspace. */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user.local && !(await publicWorkspace(ctx))) {
      await ctx.db.insert("workspaces", { ownerId: PUBLIC_OWNER, name: "Public", color: PUBLIC_COLOR, createdAt: 0, kind: "public" });
    }
    const existing = await personal(ctx, user.id);
    if (existing.length) return existing[0]._id;
    return await ctx.db.insert("workspaces", { ownerId: user.id, name: "My workspace", color: SKY_PALETTE[0], createdAt: Date.now(), kind: "personal" });
  },
});

const invitee = v.object({ email: v.string(), role: roleValidator });

/** A new workspace. A shared one starts with its invitees, and the creator decides what members may do. */
export const create = mutation({
  args: {
    name: v.string(),
    shared: v.optional(v.boolean()),
    allowMemberProjects: v.optional(v.boolean()),
    allowMemberInvites: v.optional(v.boolean()),
    members: v.optional(v.array(invitee)),
  },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (args.shared && user.local) throw new Error("Sign in to share a workspace");
    const existing = await owned(ctx, user.id);
    if (existing.length >= 24) throw new Error("You can have up to 24 workspaces");
    const id = await ctx.db.insert("workspaces", {
      ownerId: user.id,
      ...(user.email ? { ownerEmail: user.email } : {}),
      name: cleanName(args.name),
      color: SKY_PALETTE[existing.length % SKY_PALETTE.length],
      createdAt: Date.now(),
      kind: args.shared ? "shared" : "personal",
      ...(args.shared ? { allowMemberProjects: !!args.allowMemberProjects, allowMemberInvites: !!args.allowMemberInvites } : {}),
    });
    if (args.shared) for (const member of args.members ?? []) await addMember(ctx, id, member.email, member.role, user);
    return id;
  },
});

/** Name, picture, and for a shared workspace what its members may do. Only its creator can change these. */
export const update = mutation({
  args: {
    id: v.id("workspaces"),
    name: v.optional(v.string()),
    image: v.optional(v.union(v.string(), v.null())),
    allowMemberProjects: v.optional(v.boolean()),
    allowMemberInvites: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { workspace } = await requireAdmin(ctx, args.id, await currentUser(ctx));
    const shared = kindOf(workspace) === "shared";
    await ctx.db.patch(workspace._id, {
      ...(args.name !== undefined ? { name: cleanName(args.name) } : {}),
      ...(args.image === null ? { image: undefined } : args.image !== undefined ? { image: cleanImage(args.image) } : {}),
      ...(shared && args.allowMemberProjects !== undefined ? { allowMemberProjects: args.allowMemberProjects } : {}),
      ...(shared && args.allowMemberInvites !== undefined ? { allowMemberInvites: args.allowMemberInvites } : {}),
    });
  },
});

/**
 * Removing a workspace. Its projects go back to their owners' first personal workspace, so
 * nothing is lost and nothing stays visible to the old members. You keep at least one personal workspace.
 */
export const remove = mutation({
  args: { id: v.id("workspaces") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const { workspace } = await requireAdmin(ctx, args.id, user);
    const mine = await personal(ctx, user.id);
    if (kindOf(workspace) === "personal" && mine.length === 1) throw new Error("This is your only personal workspace. Create another before removing this one.");
    const moveTo = mine.find((other) => other._id !== workspace._id)!;
    let moved = 0;
    for (const project of await ctx.db.query("projects").collect()) {
      const here = project.workspaceId === workspace._id || (kindOf(workspace) === "personal" && project.ownerId === user.id && !project.workspaceId && mine[0]?._id === workspace._id);
      if (!here) continue;
      await ctx.db.patch(project._id, { workspaceId: project.ownerId === user.id ? moveTo._id : undefined });
      moved += 1;
    }
    for (const member of await ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id)).collect()) {
      await ctx.db.delete(member._id);
    }
    await ctx.db.delete(workspace._id);
    return { movedTo: moveTo._id, moved };
  },
});

async function addMember(ctx: MutationCtx, workspaceId: Id<"workspaces">, rawEmail: string, role: "viewer" | "editor", by: OfficeUser) {
  const email = cleanEmail(rawEmail);
  if (email === by.email) return;
  const rows = await ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect();
  const existing = rows.find((row) => row.email === email);
  if (existing) await ctx.db.patch(existing._id, { role });
  else await ctx.db.insert("workspaceMembers", { workspaceId, email, role, invitedBy: by.id, createdAt: Date.now() });
}

/** The people in a shared workspace. Anyone in it can see who else is. */
export const members = query({
  args: { id: v.id("workspaces") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const { workspace } = await requireRole(ctx, args.id, user);
    const rows = await ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id)).collect();
    return {
      owner: workspace.ownerEmail ?? null,
      members: rows.sort((a, b) => a.createdAt - b.createdAt).map((row) => ({ email: row.email, role: row.role, you: row.email === user.email })),
    };
  },
});

/** Invites someone by email. The creator always can; members can when the creator allows it, as viewers or as editors if they're editors. */
export const invite = mutation({
  args: { id: v.id("workspaces"), email: v.string(), role: roleValidator },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const { workspace, role, admin, canInvite } = await requireRole(ctx, args.id, user);
    if (!canInvite) throw new Error(kindOf(workspace) === "shared" ? "Only the workspace's creator can invite people here" : "Only shared workspaces have members");
    if (!admin && args.role === "editor" && role !== "editor") throw new Error("Viewers can only invite viewers");
    await addMember(ctx, workspace._id, args.email, args.role, user);
  },
});

/** Removes someone from a shared workspace. The creator can remove anyone; anyone can leave. */
export const removeMember = mutation({
  args: { id: v.id("workspaces"), email: v.string() },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const { workspace, admin } = await requireRole(ctx, args.id, user);
    const email = cleanEmail(args.email);
    if (!admin && email !== user.email) throw new Error("Only the workspace's creator can remove people");
    const rows = await ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id)).collect();
    const row = rows.find((member) => member.email === email);
    if (row) await ctx.db.delete(row._id);
  },
});

/**
 * Puts one of your projects in a workspace you may add to. Where it is decides who sees it,
 * so it's public exactly while it's in the public workspace.
 */
export const moveProject = mutation({
  args: { projectId: v.id("projects"), workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const { workspace, canAddProjects } = await requireRole(ctx, args.workspaceId, user);
    const project = await ctx.db.get(args.projectId);
    if (!project || project.ownerId !== user.id) throw new Error("Only the project's owner can move it");
    if (!canAddProjects) throw new Error(`The creator of ${workspace.name} hasn't let members add projects`);
    await ctx.db.patch(project._id, { workspaceId: workspace._id, visibility: kindOf(workspace) === "public" ? "public" : "private" });
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

/**
 * Once, when shared workspaces arrived: makes the public workspace and moves every public
 * project into it, so "public" and "in Public" mean the same thing. Safe to run again.
 */
export const migratePublic = internalMutation({
  args: {},
  handler: async (ctx) => {
    let everyone = await publicWorkspace(ctx);
    if (!everyone) {
      const id = await ctx.db.insert("workspaces", { ownerId: PUBLIC_OWNER, name: "Public", color: PUBLIC_COLOR, createdAt: 0, kind: "public" });
      everyone = (await ctx.db.get(id))!;
    }
    let moved = 0;
    for (const project of await ctx.db.query("projects").collect()) {
      if (project.visibility === "public" && project.workspaceId !== everyone._id) {
        await ctx.db.patch(project._id, { workspaceId: everyone._id });
        moved += 1;
      }
    }
    return { publicWorkspace: everyone._id, moved };
  },
});
