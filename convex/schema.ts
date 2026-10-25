import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  agentValidator,
  contributionStatusValidator,
  linkRoleValidator,
  memberRoleValidator,
  sessionLocationValidator,
  sessionStatusValidator,
  visibilityValidator,
  accessRoleValidator,
  fileChangeOpValidator,
} from "./validators";

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    ownerId: v.string(),
    repoUrl: v.optional(v.string()),
    description: v.string(),
    builtOn: v.optional(v.id("projects")),
    slug: v.string(),
    shareSlug: v.optional(v.string()),
    visibility: visibilityValidator,
    linkRole: linkRoleValidator,
    sandboxId: v.optional(v.string()),
    lastSnapshot: v.optional(v.id("_storage")),
    backup: v.optional(v.id("_storage")),
    resumeWindowStart: v.optional(v.number()),
    resumeCount: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_share_slug", ["shareSlug"]),

  sessions: defineTable({
    projectId: v.id("projects"),
    userId: v.string(),
    agent: agentValidator,
    location: sessionLocationValidator,
    status: sessionStatusValidator,
    branch: v.string(),
    envUrl: v.optional(v.string()),
    sandboxId: v.optional(v.string()),
    sandboxExtensions: v.optional(v.number()),
    previewUrl: v.optional(v.string()),
    previewStatus: v.optional(v.union(v.literal("starting"), v.literal("live"), v.literal("error"))),
    lastActiveAt: v.number(),
  }).index("by_project", ["projectId"]),

  leases: defineTable({
    projectId: v.id("projects"),
    path: v.string(),
    sessionId: v.id("sessions"),
    expiresAt: v.number(),
  }).index("by_project_path", ["projectId", "path"]),

  handoffs: defineTable({
    sessionId: v.id("sessions"),
    from: v.union(v.literal("local"), v.literal("cloud")),
    to: v.union(v.literal("local"), v.literal("cloud")),
    ref: v.string(),
    note: v.string(),
  }).index("by_session", ["sessionId"]),

  contributions: defineTable({
    fromSessionId: v.id("sessions"),
    toProjectId: v.id("projects"),
    branch: v.string(),
    summary: v.string(),
    status: contributionStatusValidator,
  }).index("by_project", ["toProjectId"]),

  events: defineTable({
    projectId: v.id("projects"),
    sessionId: v.optional(v.id("sessions")),
    kind: v.string(),
    detail: v.string(),
  }).index("by_project", ["projectId"]),

  members: defineTable({
    projectId: v.id("projects"),
    userId: v.string(),
    email: v.optional(v.string()),
    role: memberRoleValidator,
  })
    .index("by_project", ["projectId"])
    .index("by_user", ["userId"]),

  projectAccess: defineTable({
    projectId: v.id("projects"),
    email: v.string(),
    role: accessRoleValidator,
    invitedBy: v.string(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_email", ["projectId", "email"]),

  fileChanges: defineTable({
    projectId: v.id("projects"),
    sessionId: v.optional(v.id("sessions")),
    path: v.string(),
    author: v.string(),
    contentHash: v.string(),
    op: fileChangeOpValidator,
    at: v.number(),
  }).index("by_project", ["projectId"]),

  presence: defineTable({
    projectId: v.id("projects"),
    userId: v.string(),
    sessionId: v.optional(v.id("sessions")),
    agent: v.optional(agentValidator),
    lastSeenAt: v.number(),
  }).index("by_project", ["projectId"]),

  // A person's own key for Codex, Claude or Cursor, encrypted with KEY_ENCRYPTION_SECRET. Only
  // agent runs decrypt it. Rows from before providers were added have none, and are Claude.
  userKeys: defineTable({
    userId: v.string(),
    provider: v.optional(v.union(v.literal("codex"), v.literal("claude"), v.literal("cursor"))),
    ciphertext: v.string(),
    iv: v.string(),
    last4: v.string(),
    // Claude only: a Claude Pro/Max token from `claude setup-token` instead of an API key.
    subscription: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // One agent run inside a project's sandbox, started from the web office. No agent means Claude.
  agentRuns: defineTable({
    projectId: v.id("projects"),
    agent: v.optional(v.union(v.literal("codex"), v.literal("claude"), v.literal("cursor"))),
    userId: v.string(),
    userLabel: v.string(),
    sessionId: v.optional(v.id("sessions")),
    prompt: v.string(),
    status: v.union(v.literal("starting"), v.literal("running"), v.literal("done"), v.literal("error"), v.literal("stopped")),
    detail: v.optional(v.string()),
    pid: v.optional(v.number()),
    offset: v.number(),
    costUsd: v.optional(v.number()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_project", ["projectId"]),

  // What a run said and did, in order: its messages, the tools it used, and its result.
  runLines: defineTable({
    runId: v.id("agentRuns"),
    at: v.number(),
    kind: v.union(v.literal("text"), v.literal("tool"), v.literal("result"), v.literal("error")),
    text: v.string(),
  }).index("by_run", ["runId"]),

  tokens: defineTable({
    userId: v.string(),
    projectId: v.optional(v.id("projects")),
    hashedToken: v.string(),
    label: v.optional(v.string()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_hash", ["hashedToken"])
    .index("by_project", ["projectId"]),
});
