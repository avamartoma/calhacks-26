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

/**
 * Role for this caller, or null when they cannot view the project.
 * Owner (including the unsigned office user `local`) is editor.
 * An invite matches the lowercased email. Public projects grant viewer.
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
  const email = user.email;
  if (email) {
    const invite = await ctx.db
      .query("projectAccess")
      .withIndex("by_project_email", (q) => q.eq("projectId", project._id).eq("email", email))
      .unique();
    if (invite) {
      return invite.role;
    }
  }
  if (project.visibility === "public") {
    return "viewer";
  }
  return null;
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
