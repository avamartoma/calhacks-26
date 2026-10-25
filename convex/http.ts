import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";

declare const process: { env: Record<string, string | undefined> };

// HTTPS endpoints for the ASI:One (Fetch.ai) agents hosted on Agentverse, at
// https://<deployment>.convex.site/fetch/... They send `Authorization: Bearer <FETCH_AGENT_TOKEN>`;
// the token is set on this deployment and in each hosted agent's secrets, nowhere else.

const http = httpRouter();
const AGENTS = new Set(["office", "watcher", "reviewer", "planner"]);

function sameToken(given: string, expected: string) {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const message = (error: unknown) => (error instanceof Error ? error.message.replace(/^.*Uncaught Error: /s, "").split("\n")[0] : "The request failed");

/** Checks the agent's token and name, then runs `handle` with the JSON body. */
function route(handle: (ctx: ActionCtx, body: Record<string, unknown>, name: "office" | "watcher" | "reviewer" | "planner") => Promise<unknown>) {
  return httpAction(async (ctx, request) => {
    const expected = process.env.FETCH_AGENT_TOKEN;
    const given = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!expected || expected.length < 32 || !sameToken(given, expected)) return reply(401, { error: "Not an opencloud agent" });
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch { return reply(400, { error: "Send a JSON body" }); }
    } else {
      body = Object.fromEntries(new URL(request.url).searchParams);
    }
    const name = String(body.name ?? "");
    if (!AGENTS.has(name)) return reply(400, { error: "Say which agent you are: office, watcher, reviewer or planner" });
    try { return reply(200, await handle(ctx, body, name as "office" | "watcher" | "reviewer" | "planner")); }
    catch (error) { return reply(400, { error: message(error) }); }
  });
}

http.route({ path: "/fetch/heartbeat", method: "POST", handler: route((ctx, body, name) =>
  ctx.runMutation(internal.fetchAgents.heartbeat, { name, address: String(body.address ?? ""), details: body.details ?? {} })) });

http.route({ path: "/fetch/activity", method: "POST", handler: route(async (ctx, body, name) => {
  await ctx.runMutation(internal.fetchAgents.activity, { name, kind: String(body.kind ?? "note"), text: String(body.text ?? ""), ...(body.projectId ? { projectId: body.projectId as Id<"projects"> } : {}) });
  return {};
}) });

http.route({ path: "/fetch/finish", method: "POST", handler: route(async (ctx, body, name) => {
  await ctx.runMutation(internal.fetchAgents.finish, { id: body.id as Id<"fetchJobs">, name, status: body.status === "failed" ? "failed" : "done", result: body.result ?? {} });
  return {};
}) });

http.route({ path: "/fetch/state", method: "GET", handler: route((ctx) => ctx.runQuery(internal.fetchAgents.state, {}).then((projects) => ({ projects }))) });

http.route({ path: "/fetch/run", method: "GET", handler: route((ctx, body) => ctx.runQuery(internal.fetchAgents.runReport, { runId: body.runId as Id<"agentRuns"> })) });

http.route({ path: "/fetch/dispatch", method: "POST", handler: route((ctx, body, name) =>
  ctx.runMutation(internal.fetchAgents.dispatch, { name, projectId: body.projectId as Id<"projects">, prompt: String(body.prompt ?? "") })) });

http.route({ path: "/fetch/request", method: "POST", handler: route((ctx, body, name) =>
  ctx.runMutation(internal.fetchAgents.requestFromAgent, {
    name, agent: String(body.agent ?? ""), kind: String(body.kind ?? ""), projectId: body.projectId as Id<"projects">,
    ...(body.runId ? { runId: body.runId as Id<"agentRuns"> } : {}), payload: body.payload ?? {},
  })) });

export default http;
