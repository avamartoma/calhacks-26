import { v } from "convex/values";

export const agentValidator = v.union(
  v.literal("claude"),
  v.literal("cursor"),
  v.literal("codex"),
  v.literal("droid"),
);

export const sessionLocationValidator = v.union(v.literal("local"), v.literal("cloud"));

export const sessionStatusValidator = v.union(
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("stopped"),
  v.literal("error"),
);

export const visibilityValidator = v.union(
  v.literal("private"),
  v.literal("link"),
  v.literal("public"),
);

export const linkRoleValidator = v.union(
  v.literal("viewer"),
  v.literal("builder"),
  v.literal("editor"),
);

export const memberRoleValidator = v.union(
  v.literal("owner"),
  v.literal("editor"),
  v.literal("builder"),
  v.literal("viewer"),
);

export const placeValidator = v.union(v.literal("local"), v.literal("cloud"));

export const contributionStatusValidator = v.union(
  v.literal("proposed"),
  v.literal("merged"),
  v.literal("rejected"),
);

export function assertHttpsGitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("repoUrl must be an https git URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("repoUrl must use https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("repoUrl must not include credentials");
  }
  if (parsed.hostname.length === 0) {
    throw new Error("repoUrl must include a host");
  }
}

export function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base.length > 0 ? base : "project"}-${suffix}`;
}
