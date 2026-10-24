import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireAccess } from "./access";
import { recordEvent } from "./events";
import { assertNonEmpty, contributionStatusValidator } from "./validators";

export const propose = mutation({
  args: {
    fromSessionId: v.id("sessions"),
    toProjectId: v.id("projects"),
    branch: v.string(),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAccess(ctx, args.toProjectId, "editor");
    const session = await ctx.db.get(args.fromSessionId);
    if (!session) {
      throw new Error(`Session ${args.fromSessionId} not found`);
    }
    const branch = assertNonEmpty(args.branch, "branch");
    const summary = assertNonEmpty(args.summary, "summary");
    const contributionId = await ctx.db.insert("contributions", {
      fromSessionId: args.fromSessionId,
      toProjectId: args.toProjectId,
      branch,
      summary,
      status: "proposed",
    });
    await recordEvent(ctx, {
      projectId: args.toProjectId,
      sessionId: args.fromSessionId,
      kind: "contribution.proposed",
      detail: `${branch}: ${summary}`,
    });
    return contributionId;
  },
});

export const setStatus = mutation({
  args: {
    contributionId: v.id("contributions"),
    status: contributionStatusValidator,
  },
  handler: async (ctx, args) => {
    const contribution = await ctx.db.get(args.contributionId);
    if (!contribution) {
      throw new Error(`Contribution ${args.contributionId} not found`);
    }
    await requireAccess(ctx, contribution.toProjectId, "editor");
    await ctx.db.patch(args.contributionId, { status: args.status });
    await recordEvent(ctx, {
      projectId: contribution.toProjectId,
      sessionId: contribution.fromSessionId,
      kind: "contribution.status",
      detail: `${args.contributionId} ${args.status}`,
    });
    return args.contributionId;
  },
});
