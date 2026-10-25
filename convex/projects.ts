import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { grantedRole, requireAccess, visibleProjects } from "./access";
import { recordEvent } from "./events";
import { currentUser } from "./identity";
import { assertHttpsGitUrl, assertNonEmpty, slugify } from "./validators";

async function uniqueSlug(ctx: MutationCtx, name: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = slugify(name);
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!existing) {
      return slug;
    }
  }
  throw new Error("Could not allocate a unique project slug");
}

async function insertProject(
  ctx: MutationCtx,
  args: {
    name: string;
    ownerId: string;
    email?: string | null;
    repoUrl?: string;
    description: string;
    builtOn?: Id<"projects">;
  },
): Promise<Id<"projects">> {
  const name = assertNonEmpty(args.name, "name");
  const ownerId = assertNonEmpty(args.ownerId, "ownerId");
  const repoUrl = args.repoUrl?.trim() || undefined;
  if (repoUrl) assertHttpsGitUrl(repoUrl);
  const slug = await uniqueSlug(ctx, name);
  const projectId = await ctx.db.insert("projects", {
    name,
    ownerId,
    ...(repoUrl ? { repoUrl } : {}),
    description: args.description,
    ...(args.builtOn ? { builtOn: args.builtOn } : {}),
    slug,
    shareSlug: slug,
    visibility: "private",
    linkRole: "viewer",
  });
  await ctx.db.insert("members", {
    projectId,
    userId: ownerId,
    ...(args.email ? { email: args.email } : {}),
    role: "owner",
  });
  return projectId;
}

export const create = mutation({
  args: {
    name: v.string(),
    repoUrl: v.optional(v.string()),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    const projectId = await insertProject(ctx, { ...args, ownerId: user.id, email: user.email });
    await recordEvent(ctx, {
      projectId,
      kind: "project.created",
      detail: args.name.trim(),
    });
    return projectId;
  },
});

export const buildOn = mutation({
  args: {
    parentId: v.id("projects"),
    name: v.string(),
    repoUrl: v.string(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    await requireAccess(ctx, args.parentId, "editor");
    const parent = await ctx.db.get(args.parentId);
    if (!parent) {
      throw new Error("Project not found");
    }
    const projectId = await insertProject(ctx, {
      name: args.name,
      ownerId: user.id,
      email: user.email,
      repoUrl: args.repoUrl,
      description: args.description,
      builtOn: args.parentId,
    });
    await recordEvent(ctx, {
      projectId,
      kind: "project.built_on",
      detail: `built on ${parent.name} (${args.parentId})`,
    });
    await recordEvent(ctx, {
      projectId: args.parentId,
      kind: "project.forked",
      detail: `${args.name.trim()} (${projectId}) built on this project`,
    });
    return projectId;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").order("desc").collect();
    return await visibleProjects(ctx, projects);
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireAccess(ctx, args.projectId, "viewer");
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    return project;
  },
});

export const lineage = query({
  args: {},
  handler: async (ctx) => {
    const projects = await visibleProjects(ctx, await ctx.db.query("projects").collect());
    const visibleIds = new Set(projects.map((project) => project._id));
    const nodes = projects.map((project) => ({
      id: project._id,
      name: project.name,
      ownerId: project.ownerId,
      slug: project.slug,
      description: project.description,
    }));
    const edges = projects.flatMap((project) =>
      project.builtOn && visibleIds.has(project.builtOn) ? [{ from: project.builtOn, to: project._id }] : [],
    );
    return { nodes, edges };
  },
});

const MAX_UPLOAD_BYTES = 20_000_000;

/** Where the browser uploads a project folder, packed as a .tar.gz. */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (user.local) throw new Error("Sign in to upload a project");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * A project from an uploaded folder. The archive becomes the project's backup, so its first
 * sandbox starts from those files the same way a paused project is restored.
 */
export const createFromUpload = mutation({
  args: { name: v.string(), description: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (user.local) throw new Error("Sign in to upload a project");
    const file = await ctx.db.system.get(args.storageId);
    if (!file) throw new Error("The upload did not arrive. Try again.");
    if (file.size > MAX_UPLOAD_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new Error("That folder is over 20 MB once packed. Leave out build output and dependencies.");
    }
    const projectId = await insertProject(ctx, { name: args.name, description: args.description, ownerId: user.id, email: user.email });
    await ctx.db.patch(projectId, { backup: args.storageId });
    await recordEvent(ctx, { projectId, kind: "project.created", detail: `${args.name.trim()} (uploaded)` });
    return projectId;
  },
});

/**
 * Everything on the caller's sky: their own projects, ones shared with them, and public ones,
 * each with its preview and agents.
 */
export const sky = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const projects = await ctx.db.query("projects").order("desc").collect();
    const rows = [];
    for (const project of projects) {
      const role = await grantedRole(ctx, project, user);
      if (!role) continue;
      const mine = project.ownerId === user.id;
      // Signed out, the sky is only the unsigned office's own projects.
      if (!mine && user.local) continue;
      const owner = await ctx.db.query("members").withIndex("by_project", (q) => q.eq("projectId", project._id)).collect();
      const sessions = await ctx.db.query("sessions").withIndex("by_project", (q) => q.eq("projectId", project._id)).order("desc").take(1);
      const runs = await ctx.db.query("agentRuns").withIndex("by_project", (q) => q.eq("projectId", project._id)).order("desc").take(6);
      const snapshotUrl = project.lastSnapshot ? await ctx.storage.getUrl(project.lastSnapshot) : null;
      rows.push({
        id: project._id,
        name: project.name,
        description: project.description,
        slug: project.shareSlug ?? project.slug,
        visibility: project.visibility,
        role,
        mine,
        owner: owner.find((member) => member.role === "owner")?.email ?? null,
        repoUrl: project.repoUrl ?? null,
        session: sessions[0] ? { id: sessions[0]._id, status: sessions[0].status, previewUrl: sessions[0].previewUrl ?? null, previewStatus: sessions[0].previewStatus ?? null } : null,
        snapshotUrl,
        runs: runs.map((run) => ({ id: run._id, agent: run.agent ?? "claude", status: run.status, userLabel: run.userLabel, prompt: run.prompt.slice(0, 120) })),
      });
    }
    return rows;
  },
});
