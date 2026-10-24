import { ConvexHttpClient } from "convex/browser";

const functionName = Symbol.for("functionName");

function convexRef(name: string) {
  return { [functionName]: name };
}

const functionRefs = {
  sharingGet: convexRef("sharing:get"),
  sharingSetVisibility: convexRef("sharing:setVisibility"),
  sharingInvite: convexRef("sharing:invite"),
  sharingRemove: convexRef("sharing:remove"),
  sharingList: convexRef("sharing:list"),
  sessionsResume: convexRef("sessions:resume"),
  sessionsGet: convexRef("sessions:get"),
  eventsByProject: convexRef("events:byProject"),
};

export const shareApi = functionRefs;

type Call = (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;

export function convexUrl(): string {
  const configured = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
  return configured || "http://127.0.0.1:3210";
}

let browserClient: ConvexHttpClient | null = null;

export function convexBrowser(): ConvexHttpClient {
  if (!browserClient) browserClient = new ConvexHttpClient(convexUrl());
  return browserClient;
}

export function convexQuery(client: ConvexHttpClient, ref: unknown, args: Record<string, unknown>): Promise<unknown> {
  return (client.query as Call)(ref, args);
}

export function convexMutation(client: ConvexHttpClient, ref: unknown, args: Record<string, unknown>): Promise<unknown> {
  return (client.mutation as Call)(ref, args);
}

const resumes = new Map<string, Promise<string>>();

export function resumeProject(client: ConvexHttpClient, projectId: string): Promise<string> {
  const existing = resumes.get(projectId);
  if (existing) return existing;
  const pending = convexMutation(client, shareApi.sessionsResume, { projectId })
    .then((value) => {
      if (typeof value === "string" && value) return value;
      if (value && typeof value === "object" && "sessionId" in value) {
        const sessionId = (value as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === "string" && sessionId) return sessionId;
      }
      throw new Error("sessions.resume did not return a session id.");
    })
    .catch((error: unknown) => {
      resumes.delete(projectId);
      throw error;
    });
  resumes.set(projectId, pending);
  return pending;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "The request failed.";
}

export function isJwt(value: unknown): value is string {
  return typeof value === "string" && value.split(".").length === 3 && value.length > 20;
}
