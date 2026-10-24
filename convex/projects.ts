import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { recordEvent } from "./events";
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
    visibility: "private",
    linkRole: "viewer",
  });
  await ctx.db.insert("members", {
    projectId,
    userId: ownerId,
    role: "owner",
  });
  return projectId;
}

export const create = mutation({
  args: {
    name: v.string(),
    ownerId: v.string(),
    repoUrl: v.optional(v.string()),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const projectId = await insertProject(ctx, args);
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
    ownerId: v.string(),
    repoUrl: v.string(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.parentId);
    if (!parent) {
      throw new Error(`Project ${args.parentId} not found`);
    }
    const projectId = await insertProject(ctx, {
      name: args.name,
      ownerId: args.ownerId,
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
    return await ctx.db.query("projects").order("desc").collect();
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new Error(`Project ${args.projectId} not found`);
    }
    return project;
  },
});

export const lineage = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    const nodes = projects.map((project) => ({
      id: project._id,
      name: project.name,
      ownerId: project.ownerId,
      slug: project.slug,
      description: project.description,
    }));
    const edges = projects.flatMap((project) =>
      project.builtOn ? [{ from: project.builtOn, to: project._id }] : [],
    );
    return { nodes, edges };
  },
});
