import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { currentUser, type OfficeUser } from "./identity";
import { accessRoleValidator } from "./validators";

export type AccessRole = "viewer" | "editor";

type AccessCtx = QueryCtx | MutationCtx;

const ROLE_RANK: Record<AccessRole, number> = {
  viewer: 0,
  editor: 1,
};

export type WorkspaceRole = "admin" | AccessRole;

/**
 * The caller's place in a workspace, or null when they're not in it. Its creator is admin.
 * Everyone signed in is a viewer of the public workspace. Members of a shared workspace have
 * the role they were invited with, matched by lowercased email.
 */
export async function workspaceRole(ctx: AccessCtx, workspace: Doc<"workspaces">, user: OfficeUser): Promise<WorkspaceRole | null> {
  if (workspace.kind === "public") return user.local ? null : "viewer";
  if (workspace.ownerId === user.id) return "admin";
  if (workspace.kind !== "shared" || !user.email) return null;
  const rows = await ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id)).collect();
  return rows.find((row) => row.email === user.email)?.role ?? null;
}

const best = (a: AccessRole | null, b: AccessRole | null) => (!a ? b : !b ? a : ROLE_RANK[a] >= ROLE_RANK[b] ? a : b);

/**
 * Role for this caller, or null when they cannot view the project.
 * Owner (including the unsigned office user `local`) is editor. Otherwise the highest of:
 * an invite to the project (matched by lowercased email), being public (viewer), and the
 * project's workspace (public: viewer; shared: the member's role, and editor for its creator).
 * `link` does not grant access.
 */
export async function grantedRole(
  ctx: AccessCtx,
  project: Doc<"projects">,
  user: OfficeUser,
): Promise<AccessRole | null> {
  if (project.ownerId === user.id) {
    return "editor";
  }
  let role: AccessRole | null = null;
  const email = user.email;
  if (email) {
    const invite = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_email", (q) => q.eq("projectId", project._id).eq("email", email))
      .unique();
    role = best(role, invite?.role ?? null);
  }
  if (project.visibility === "public") {
    role = best(role, "viewer");
  }
  const workspace = project.workspaceId ? await ctx.db.get(project.workspaceId) : null;
  if (workspace && workspace.kind && workspace.kind !== "personal") {
    const inWorkspace = await workspaceRole(ctx, workspace, user);
    role = best(role, inWorkspace === "admin" ? "editor" : inWorkspace);
  }
  return role;
}

export async function requireAccess(
  ctx: AccessCtx,
  projectId: Id<"projects">,
  minRole: AccessRole,
): Promise<AccessRole> {
  const project = await ctx.db.get(projectId);
  if (!project) {
    throw new Error("Project not found");
  }
  const user = await currentUser(ctx);
  const role = await grantedRole(ctx, project, user);
  if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new Error("You do not have access to this project");
  }
  return role;
}

export async function visibleProjects(ctx: AccessCtx, projects: Doc<"projects">[]): Promise<Doc<"projects">[]> {
  const user = await currentUser(ctx);
  const visible: Doc<"projects">[] = [];
  for (const project of projects) {
    if (await grantedRole(ctx, project, user)) {
      visible.push(project);
    }
  }
  return visible;
}

/** Actions have no database handle. They run this with the caller's auth. */
export const requireRole = internalQuery({
  args: {
    projectId: v.id("projects"),
    minRole: accessRoleValidator,
  },
  handler: async (ctx, args) => requireAccess(ctx, args.projectId, args.minRole),
});
