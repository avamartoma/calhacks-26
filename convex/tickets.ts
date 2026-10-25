import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { requireAccess } from "./access";
import { currentUser } from "./identity";
import { keyRow } from "./keyStore";
import { MANAGER_INSTRUCTIONS, MANAGER_ROLE, ROLE_INSTRUCTIONS, roleOf, sameRole } from "./lib/roles";
import { freeName } from "./projectAgents";

// Tickets in the web office. Every project has a project manager. Asking it for something makes its
// plan ticket; it splits the request into tickets for each role (builtinAgents.splitRequest), hands
// each to the agent with that role, spinning one up when there isn't one, and the tickets run one
// after another on the requester's own connection. Each pass from one agent to another is a handoff.

const MAX_TEXT = 8000;
const PROVIDERS = ["claude", "codex", "cursor"] as const;
const clip = (text: string, n: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat; };
const agentsOf = (ctx: QueryCtx, projectId: Id<"projects">) => ctx.db.query("projectAgents").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect();
const requestOf = (ctx: QueryCtx, requestId: Id<"tickets">) => ctx.db.query("tickets").withIndex("by_request", (q) => q.eq("requestId", requestId)).collect();

/** The program a new agent runs on: the first one this person has connected, else Claude. */
async function engineFor(ctx: QueryCtx, userId: string) {
  for (const provider of PROVIDERS) if (userId && (await keyRow(ctx, userId, provider))) return provider;
  return "claude" as const;
}

export async function ensureManagerFor(ctx: MutationCtx, projectId: Id<"projects">, userId: string): Promise<Doc<"projectAgents">> {
  const agents = await agentsOf(ctx, projectId);
  const found = agents.find((agent) => agent.manager);
  if (found) return found;
  const taken = agents.map((agent) => agent.name);
  const name = taken.includes("Gus") ? await freeName(taken, `manager${projectId}`) : "Gus";
  const id = await ctx.db.insert("projectAgents", { projectId, name, role: MANAGER_ROLE, engine: await engineFor(ctx, userId), instructions: MANAGER_INSTRUCTIONS, createdBy: userId, manager: true });
  return (await ctx.db.get(id))!;
}

/** Gives the project its project manager if it doesn't have one yet. The office calls this on opening. */
export const ensureManager = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireAccess(ctx, args.projectId, "editor");
    const user = await currentUser(ctx);
    return (await ensureManagerFor(ctx, args.projectId, user.id))._id;
  },
});

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireAccess(ctx, args.projectId, "viewer");
    const user = await currentUser(ctx);
    const rows = await ctx.db.query("tickets").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect();
    return await Promise.all(rows.map(async (ticket) => {
      const run = ticket.runId ? await ctx.db.get(ticket.runId) : null;
      return {
        id: ticket._id, agentId: ticket.agentId ?? null, requestId: ticket.requestId ?? null, order: ticket.order,
        title: ticket.title, description: ticket.description, role: ticket.role, status: ticket.status,
        runId: ticket.runId ?? null, runMine: run ? run.userId === user.id : false, result: run?.detail ?? null,
        note: ticket.note ?? null, handoffs: ticket.handoffs, by: ticket.createdByLabel,
        createdAt: ticket._creationTime, archivedAt: ticket.archivedAt ?? null,
      };
    }));
  },
});

/** Asks the project manager for something. It plans, then hands out tickets. */
export const request = mutation({
  args: { projectId: v.id("projects"), text: v.string() },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    await requireAccess(ctx, args.projectId, "editor");
    const text = args.text.trim();
    if (text.length < 3) throw new Error("Say what you'd like done");
    if (text.length > MAX_TEXT) throw new Error(`Keep the request under ${MAX_TEXT} characters`);
    const manager = await ensureManagerFor(ctx, args.projectId, user.id);
    const ticketId = await ctx.db.insert("tickets", {
      projectId: args.projectId, agentId: manager._id, order: 0, title: `Plan: ${clip(text.split("\n")[0], 110)}`, description: text,
      role: MANAGER_ROLE, status: "planning", handoffs: [], createdBy: user.id, createdByLabel: user.name || user.email || "Someone",
    });
    await ctx.scheduler.runAfter(0, internal.builtinAgents.splitRequest, { ticketId });
    return ticketId;
  },
});

/** What the project manager needs to split a request. */
export const planContext = internalQuery({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket || ticket.status !== "planning") return null;
    const project = await ctx.db.get(ticket.projectId);
    const agents = await agentsOf(ctx, ticket.projectId);
    return {
      text: ticket.description, requesterId: ticket.createdBy,
      project: { name: project?.name ?? "", description: project?.description ?? "" },
      agents: agents.filter((agent) => !agent.manager).map((agent) => ({ name: agent.name, role: agent.role })),
    };
  },
});

/** Hands out the manager's tickets, spinning up an agent for any role no one has, and starts the first. */
export const applyPlan = internalMutation({
  args: { planId: v.id("tickets"), tickets: v.array(v.object({ title: v.string(), description: v.string(), role: v.string() })), modeled: v.boolean() },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.status !== "planning") return;
    const manager = plan.agentId ? await ctx.db.get(plan.agentId) : null;
    let agents = await agentsOf(ctx, plan.projectId);
    const spun: string[] = [];
    let first: Id<"tickets"> | null = null;
    for (const [index, item] of args.tickets.slice(0, 6).entries()) {
      const role = roleOf(item.role);
      let owner = agents.find((agent) => !agent.manager && sameRole(agent.role, role));
      if (!owner) {
        const name = await freeName(agents.map((agent) => agent.name), `${role}${plan.projectId}`);
        const id = await ctx.db.insert("projectAgents", { projectId: plan.projectId, name, role, engine: await engineFor(ctx, plan.createdBy), instructions: ROLE_INSTRUCTIONS[role], createdBy: plan.createdBy });
        owner = (await ctx.db.get(id))!;
        agents = [...agents, owner];
        spun.push(`${name} (${role})`);
      }
      const id = await ctx.db.insert("tickets", {
        projectId: plan.projectId, agentId: owner._id, requestId: plan._id, order: index + 1,
        title: clip(item.title, 120) || clip(item.description, 120), description: item.description.slice(0, 4000), role, status: "todo",
        handoffs: [{ from: manager?.name ?? "Project manager", to: owner.name, at: Date.now() }],
        createdBy: plan.createdBy, createdByLabel: plan.createdByLabel,
      });
      first ??= id;
    }
    const count = Math.min(args.tickets.length, 6);
    await ctx.db.patch(plan._id, {
      status: "done",
      note: `Split into ${count} ticket${count === 1 ? "" : "s"}${spun.length ? `, and brought in ${spun.join(", ")}` : ""}.${args.modeled ? "" : " Planned without a model: connect a Claude API key in Accounts for a better split."}`,
    });
    await ctx.db.insert("fetchActivity", { name: "watcher", kind: "noticed", text: `${manager?.name ?? "The project manager"} planned **${clip(plan.description, 100)}** into ${count} ticket(s)${spun.length ? `, bringing in ${spun.join(", ")}` : ""}`, projectId: plan.projectId });
    if (first) await startTicket(ctx, first, plan.createdBy, plan.createdByLabel);
  },
});

/** The planner failed outright: the plan ticket says so, and can be asked again. */
export const planFailed = internalMutation({
  args: { planId: v.id("tickets"), error: v.string() },
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (plan?.status === "planning") await ctx.db.patch(plan._id, { status: "failed", note: args.error.slice(0, 300) });
  },
});

/** Starts the ticket's agent on it, on this person's connection. Returns why it couldn't, if it couldn't. */
async function startTicket(ctx: MutationCtx, ticketId: Id<"tickets">, userId: string, userLabel: string): Promise<string | null> {
  const ticket = await ctx.db.get(ticketId);
  if (!ticket || ticket.archivedAt || ticket.status === "working" || ticket.status === "planning") return null;
  const agent = ticket.agentId ? await ctx.db.get(ticket.agentId) : null;
  if (!agent) return "Hand this ticket to an agent first";
  let connected = false;
  for (const provider of PROVIDERS) if (await keyRow(ctx, userId, provider)) connected = true;
  if (!connected) {
    await ctx.db.patch(ticket._id, { note: "Waiting for a connection: connect Claude, Codex or Cursor in Accounts, then press Start." });
    return "Connect Codex, Claude or Cursor in Accounts first";
  }
  const request = ticket.requestId ? await ctx.db.get(ticket.requestId) : null;
  const earlier = ticket.requestId ? (await requestOf(ctx, ticket.requestId)).filter((other) => other.order < ticket.order && other.status === "done").sort((a, b) => a.order - b.order) : [];
  const done: string[] = [];
  for (const other of earlier) {
    const who = other.agentId ? await ctx.db.get(other.agentId) : null;
    const run = other.runId ? await ctx.db.get(other.runId) : null;
    done.push(`- ${other.title}${who ? ` (${who.name}, ${who.role})` : ""}${run?.detail ? `: ${clip(run.detail, 600)}` : ""}`);
  }
  const handoff = ticket.handoffs[ticket.handoffs.length - 1];
  const prompt = [
    `You are ${agent.name}, the ${agent.role} on this project's team. ${agent.instructions}`,
    `Your ticket: ${ticket.title}\n${ticket.description}`,
    request ? `It's part of this request from ${request.createdByLabel}: ${request.description}` : "",
    done.length ? `Teammates already finished:\n${done.join("\n")}` : "",
    handoff?.note ? `${handoff.from} handed this to you: ${handoff.note}` : "",
    "Stick to your ticket and your role. Finish with a short summary of what you did.",
  ].filter(Boolean).join("\n\n");
  const started = await ctx.runMutation(internal.fetchAgents.startFor, {
    projectId: ticket.projectId, userId, userLabel: `${agent.name} (${userLabel})`, prompt, via: "manager", prefer: agent.engine,
  });
  await ctx.db.patch(ticket._id, { status: "working", runId: started.runId, note: undefined });
  return null;
}

/** agentRuns.finish calls this: the ticket is done or failed, and a finished one passes the work on. */
export async function ticketRunFinished(ctx: MutationCtx, runId: Id<"agentRuns">, status: "done" | "error" | "stopped") {
  const ticket = await ctx.db.query("tickets").withIndex("by_run", (q) => q.eq("runId", runId)).first();
  if (!ticket) return;
  await ctx.db.patch(ticket._id, { status: status === "done" ? "done" : status === "error" ? "failed" : "todo" });
  if (status !== "done" || !ticket.requestId || ticket.archivedAt) return;
  const next = (await requestOf(ctx, ticket.requestId)).filter((other) => other.status === "todo" && !other.archivedAt && other.order > ticket.order).sort((a, b) => a.order - b.order)[0];
  if (!next) return;
  const from = ticket.agentId ? await ctx.db.get(ticket.agentId) : null;
  const to = next.agentId ? await ctx.db.get(next.agentId) : null;
  if (from && to && from._id !== to._id) await ctx.db.patch(next._id, { handoffs: [...next.handoffs, { from: from.name, to: to.name, at: Date.now(), note: `Finished “${clip(ticket.title, 80)}”, over to you.` }] });
  await startTicket(ctx, next._id, ticket.createdBy, ticket.createdByLabel);
}

/** Starts (or starts again) a ticket by hand. */
export const start = mutation({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx);
    if (user.local) throw new Error("Sign in to start an agent");
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("Ticket not found");
    await requireAccess(ctx, ticket.projectId, "editor");
    if (ticket.status === "working") throw new Error("This ticket is already being worked on");
    const problem = await startTicket(ctx, ticket._id, user.id, user.name || user.email || "Someone");
    if (problem) throw new Error(problem);
    return ticket.runId;
  },
});

/** Moves a ticket to another agent, noting the handoff on it. */
export const handOff = mutation({
  args: { ticketId: v.id("tickets"), toAgentId: v.id("projectAgents"), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("Ticket not found");
    await requireAccess(ctx, ticket.projectId, "editor");
    if (ticket.status === "working" || ticket.status === "planning") throw new Error("Wait for this ticket to finish, or stop it, before handing it off");
    const to = await ctx.db.get(args.toAgentId);
    if (!to || to.projectId !== ticket.projectId) throw new Error("Choose an agent in this project");
    if (to._id === ticket.agentId) return { ok: true as const };
    const from = ticket.agentId ? await ctx.db.get(ticket.agentId) : null;
    const note = args.note?.trim() ? clip(args.note, 500) : undefined;
    await ctx.db.patch(ticket._id, {
      agentId: to._id, status: "todo", note: undefined,
      handoffs: [...ticket.handoffs, { from: from?.name ?? "Unassigned", to: to.name, at: Date.now(), ...(note ? { note } : {}) }],
    });
    return { ok: true as const };
  },
});

/** Moves a ticket to the archive at the bottom of the office, or back. */
export const archive = mutation({
  args: { ticketId: v.id("tickets"), archived: v.boolean() },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("Ticket not found");
    await requireAccess(ctx, ticket.projectId, "editor");
    await ctx.db.patch(ticket._id, { archivedAt: args.archived ? Date.now() : undefined });
    return { ok: true as const };
  },
});

/** Deletes an archived ticket for good. Its agent run, if it had one, stays in the project's history. */
export const remove = mutation({
  args: { ticketId: v.id("tickets") },
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) return { ok: true as const };
    await requireAccess(ctx, ticket.projectId, "editor");
    if (!ticket.archivedAt) throw new Error("Archive the ticket before deleting it");
    await ctx.db.delete(ticket._id);
    return { ok: true as const };
  },
});
