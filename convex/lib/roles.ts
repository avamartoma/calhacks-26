import { kindOf } from "../../src/sky/agents";

// The roles a project manager hands tickets to. Each one is a type on the sky (src/sky/agents.ts),
// so a Builder is colored like any other build agent.

export const MANAGER_ROLE = "Project Manager";
export const ROLES = ["Builder", "Reviewer", "Writer", "Researcher", "Data analyst"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INSTRUCTIONS: Record<Role, string> = {
  Builder: "Writes and changes the project's code to do what the ticket asks, and runs it to check it works.",
  Reviewer: "Checks teammates' work: reads the changes, runs the tests and the app, and reports what's wrong or confirms it's ready. Fixes only small slips.",
  Writer: "Writes docs, READMEs, copy and release notes for the project.",
  Researcher: "Investigates the code or the options for the ticket and reports clear findings and a recommendation, without big changes.",
  "Data analyst": "Works on the project's data: queries, pipelines, cleaning and charts.",
};

export const MANAGER_INSTRUCTIONS = "Plans the work on this project: splits each request into tickets for the right roles, hands them out in order, and spins up a new agent when no one has the role yet.";

/** The ticket role for anything an agent or the model calls a role: Builder when nothing more specific fits. */
export function roleOf(text: string): Role {
  const exact = ROLES.find((role) => role.toLowerCase() === text.trim().toLowerCase());
  if (exact) return exact;
  const kind = kindOf(text).id;
  return ({ review: "Reviewer", writing: "Writer", research: "Researcher", data: "Data analyst" } as Record<string, Role>)[kind] ?? "Builder";
}

/** Whether an agent with this role takes tickets for that role. */
export const sameRole = (agentRole: string, role: string) => roleOf(agentRole) === roleOf(role) && kindOf(agentRole).id !== "manager";
