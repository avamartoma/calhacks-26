import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { requireAccess } from "./access";
import { currentUser } from "./identity";
import { agentKinds } from "../src/sky/agents";
import { checkModel } from "./lib/models";

// Lasting agents in the web office: a named agent with a role, the program it runs on, and its
// instructions. Cloning one, or any agent run, into another project you can edit makes a copy there,
// which you can start on your own connection.

const NAMES = ["Sage", "Gus", "Marge", "Vera", "Ivy", "Otto", "Juno", "Remy", "Nova", "Pip", "Wren", "Milo", "Iris", "Theo", "Luna", "Kit"];
const ENGINES = { claude: "Claude", codex: "Codex", cursor: "Cursor" } as const;
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** An agent's type from what it was asked to do, as the sky colors it. Build when nothing more specific fits. */
function roleFor(task: string) {
  return (agentKinds.find((kind) => kind.match.test(task)) ?? agentKinds.find((kind) => kind.id === "build")!).label;
}

/** A name not already taken in the project. */
export async function freeName(taken: string[], seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[(hash + i) % NAMES.length];
    if (!taken.includes(name)) return name;
  }
  return `${NAMES[hash % NAMES.length]} ${taken.length + 1}`;
}

const shape = (agent: Doc<"projectAgents">) => ({
  id: agent._id, name: agent.name, role: agent.role, engine: agent.engine, instructions: agent.instructions,
  clonedFrom: agent.clonedFrom ?? null, createdAt: agent._creationTime, manager: !!agent.manager, model: agent.model ?? "",
});

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireAccess(ctx, args.projectId, "viewer");
    const agents = await ctx.db.query("projectAgents").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect();
    return agents.map(shape);
  },
});

/**
 * Copies an agent, or an agent run, into another project. Needs to see the original and to edit the
 * project it goes to. Returns what the web office needs to show the agent travelling across the sky.
 */
export const clone = mutation({
  args: { targetProjectId: v.id("projects"), agentId: v.optional(v.id("projectAgents")), runId: v.optional(v.id("agentRuns")) },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    let source: { projectId: Id<"projects">; name: string; role: string; engine: "codex" | "claude" | "cursor"; instructions: string };
    if (args.agentId) {
      const agent = await ctx.db.get(args.agentId);
      if (!agent) throw new Error("Agent not found");
      source = { projectId: agent.projectId, name: agent.name, role: agent.role, engine: agent.engine, instructions: agent.instructions };
    } else if (args.runId) {
      const run = await ctx.db.get(args.runId);
      if (!run) throw new Error("Agent not found");
      const engine = run.agent ?? "claude";
      source = { projectId: run.projectId, name: `${ENGINES[engine]} · ${run.userLabel}`, role: roleFor(run.prompt), engine, instructions: run.prompt };
    } else throw new Error("Say which agent to clone");
    await requireAccess(ctx, source.projectId, "viewer");
    await requireAccess(ctx, args.targetProjectId, "editor");
    if (source.projectId === args.targetProjectId) throw new Error("That agent is already in this project");
    const from = await ctx.db.get(source.projectId);
    const existing = await ctx.db.query("projectAgents").withIndex("by_project", (q) => q.eq("projectId", args.targetProjectId)).collect();
    const name = args.agentId && !existing.some((agent) => agent.name === source.name) ? source.name : await freeName(existing.map((agent) => agent.name), `${source.name}${args.targetProjectId}`);
    const agentId = await ctx.db.insert("projectAgents", {
      projectId: args.targetProjectId, name, role: source.role, engine: source.engine, instructions: clip(source.instructions, 8000),
      clonedFrom: { projectId: source.projectId, projectName: from?.name ?? "another project", agentName: source.name },
      createdBy: user.id,
    });
    await ctx.db.insert("fetchActivity", { name: "watcher", kind: "noticed", text: `${user.name || user.email || "Someone"} cloned **${source.name}** in as **${name}** (${source.role}) from ${from?.name ?? "another project"}`, projectId: args.targetProjectId });
    return { agentId, name, role: source.role, fromProjectId: source.projectId, toProjectId: args.targetProjectId };
  },
});

/** Starts the agent on its instructions, plus anything extra you ask, on your own connection. */
export const start = mutation({
  args: { agentId: v.id("projectAgents"), task: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ runId: Id<"agentRuns">; agent: "codex" | "claude" | "cursor" }> => {
    const user = await currentUser(ctx);
    if (user.local) throw new Error("Sign in to start an agent");
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");
    await requireAccess(ctx, agent.projectId, "editor");
    const extra = args.task?.trim();
    const prompt = `You are ${agent.name}, the ${agent.role} agent on this project.\n\n${agent.instructions}${extra ? `\n\nNow: ${extra}` : ""}`;
    return await ctx.runMutation(internal.fetchAgents.startFor, {
      projectId: agent.projectId, userId: user.id, userLabel: `${agent.name} (${user.name || user.email || "you"})`, prompt, via: "office", prefer: agent.engine, ...(agent.model ? { model: agent.model } : {}),
    });
  },
});

/** Changes the program an agent runs on and its model. Its next ticket uses them. */
export const configure = mutation({
  args: { agentId: v.id("projectAgents"), engine: v.union(v.literal("codex"), v.literal("claude"), v.literal("cursor")), model: v.string() },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) throw new Error("Agent not found");
    await requireAccess(ctx, agent.projectId, "editor");
    await ctx.db.patch(agent._id, { engine: args.engine, model: checkModel(args.engine, args.model) });
    return { ok: true as const };
  },
});

export const remove = mutation({
  args: { agentId: v.id("projectAgents") },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return { ok: true as const };
    await requireAccess(ctx, agent.projectId, "editor");
    if (agent.manager) throw new Error("Every project keeps its project manager");
    // Its tickets stay, waiting to be handed to someone else.
    for (const ticket of await ctx.db.query("tickets").withIndex("by_project", (q) => q.eq("projectId", agent.projectId)).collect()) {
      if (ticket.agentId === agent._id) await ctx.db.patch(ticket._id, { agentId: undefined, ...(ticket.status === "working" ? {} : { status: ticket.status === "done" ? "done" : "todo" }) });
    }
    await ctx.db.delete(agent._id);
    return { ok: true as const };
  },
});
