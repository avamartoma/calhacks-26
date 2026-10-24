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
} from "./validators";

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    ownerId: v.string(),
    repoUrl: v.optional(v.string()),
    description: v.string(),
    builtOn: v.optional(v.id("projects")),
    slug: v.string(),
    visibility: visibilityValidator,
    linkRole: linkRoleValidator,
  }).index("by_slug", ["slug"]),

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
    role: memberRoleValidator,
  })
    .index("by_project", ["projectId"])
    .index("by_user", ["userId"]),

  presence: defineTable({
    projectId: v.id("projects"),
    userId: v.string(),
    sessionId: v.optional(v.id("sessions")),
    agent: v.optional(agentValidator),
    lastSeenAt: v.number(),
  }).index("by_project", ["projectId"]),

  tokens: defineTable({
    userId: v.string(),
    hashedToken: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_hash", ["hashedToken"]),
});
