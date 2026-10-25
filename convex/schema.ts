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
    // Set when the project was added from the owner's GitHub repos, so a repo is only added once.
    githubRepoId: v.optional(v.number()),
    // The owner's workspace it sits in. None means the owner's first workspace.
    workspaceId: v.optional(v.id("workspaces")),
    // The owner let the team's hosted Fetch.ai agents read this project and start work on it.
    fetchDemo: v.optional(v.boolean()),
  })
    .index("by_owner_github", ["ownerId", "githubRepoId"])
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
    // How it was connected. A signed-in account (ChatGPT for Codex, Claude, Cursor) stores that
    // tool's own credentials, which a run uses and may refresh. Rows without one hold a key.
    method: v.optional(v.union(v.literal("apiKey"), v.literal("chatgpt"), v.literal("claudeAccount"), v.literal("cursorAccount"))),
    email: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // A sign-in someone started from Connections and hasn't finished. The verifier and state are
  // encrypted; the browser only ever sees the link, the code to enter and the outcome.
  logins: defineTable({
    userId: v.string(),
    provider: v.union(v.literal("codex"), v.literal("claude"), v.literal("cursor")),
    status: v.union(v.literal("preparing"), v.literal("waiting"), v.literal("done"), v.literal("error"), v.literal("cancelled")),
    url: v.optional(v.string()),
    code: v.optional(v.string()),
    detail: v.optional(v.string()),
    secret: v.optional(v.object({ ciphertext: v.string(), iv: v.string() })),
    sandboxId: v.optional(v.string()),
    expiresAt: v.number(),
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
    // A follow-up continues an earlier run's conversation: the first run of the thread, and the
    // agent's own session to resume. agentSession is the session this run reported.
    parentRunId: v.optional(v.id("agentRuns")),
    resumeSession: v.optional(v.string()),
    agentSession: v.optional(v.string()),
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

  // The ASI:One (Fetch.ai) agents hosted on Agentverse: who checked in last, what they did, and the
  // work the web office queued for them. They reach Convex over HTTPS with FETCH_AGENT_TOKEN.
  fetchAgents: defineTable({
    name: v.string(),
    address: v.string(),
    details: v.any(),
    lastSeen: v.number(),
  }).index("by_name", ["name"]),

  fetchActivity: defineTable({
    name: v.string(),
    kind: v.string(),
    text: v.string(),
    projectId: v.optional(v.id("projects")),
  }).index("by_project", ["projectId"]),

  fetchJobs: defineTable({
    agent: v.string(),
    kind: v.string(),
    projectId: v.id("projects"),
    runId: v.optional(v.id("agentRuns")),
    payload: v.any(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
    result: v.optional(v.any()),
    requestedBy: v.string(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_agent_status", ["agent", "status"])
    .index("by_project", ["projectId"]),

  // What one agent run changed: a snapshot of the workspace (in a shadow git history kept apart
  // from the project's own) taken just before it started, then the files and patch after it ended.
  runChanges: defineTable({
    runId: v.id("agentRuns"),
    projectId: v.id("projects"),
    baseline: v.optional(v.string()),
    files: v.optional(v.array(v.object({ path: v.string(), added: v.number(), removed: v.number() }))),
    patch: v.optional(v.id("_storage")),
    truncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
  }).index("by_run", ["runId"]),

  // Skies on the workspace rail. Personal ones are their owner's alone (no kind means personal).
  // A shared one has members, invited by email. The one public workspace (owner "public") is
  // everyone's, and a project in it is visible to everyone signed in.
  workspaces: defineTable({
    ownerId: v.string(),
    ownerEmail: v.optional(v.string()),
    name: v.string(),
    color: v.string(),
    image: v.optional(v.string()),
    createdAt: v.number(),
    kind: v.optional(v.union(v.literal("personal"), v.literal("shared"), v.literal("public"))),
    // Set by the shared workspace's creator.
    allowMemberProjects: v.optional(v.boolean()),
    allowMemberInvites: v.optional(v.boolean()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_kind", ["kind"]),

  // People invited to a shared workspace. The email is how they're recognized when they sign in.
  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: v.union(v.literal("viewer"), v.literal("editor")),
    invitedBy: v.string(),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_email", ["email"]),

  // Where a person dragged a cloud on their sky, so it is there on any computer they sign in on.
  skyPositions: defineTable({
    userId: v.string(),
    projectId: v.id("projects"),
    x: v.number(),
    y: v.number(),
  }).index("by_user_project", ["userId", "projectId"]),
});
