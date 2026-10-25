import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

export function convexUrl(): string {
  return process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL || "http://127.0.0.1:3210";
}

export type GatewayCall = {
  token: string;
  projectId: string;
  tool: "list_files" | "read_file" | "write_file" | "delete_file" | "run_command" | "get_preview_url";
  path?: string;
  content?: string;
  command?: string;
};

export async function callGateway(input: GatewayCall): Promise<Record<string, unknown>> {
  const client = new ConvexHttpClient(convexUrl(), { logger: false });
  const args: Record<string, string> = {
    token: input.token,
    projectId: input.projectId,
    tool: input.tool,
  };
  if (input.path !== undefined) args.path = input.path;
  if (input.content !== undefined) args.content = input.content;
  if (input.command !== undefined) args.command = input.command;
  const result = await client.action(anyApi.agentTokens.gateway, args);
  if (!result || typeof result !== "object") {
    throw new Error("Agent gateway returned an unexpected result");
  }
  return result as Record<string, unknown>;
}

export function safeMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Agent gateway failed";
  const uncaught = error.message.split("\n").find((line) => line.includes("Uncaught Error:"));
  const text = (uncaught ?? error.message.split("\n")[0] ?? "Agent gateway failed")
    .replace(/^\[CONVEX [^\]]+\]\s*/, "")
    .replace(/^(Uncaught )?Error:\s*/, "")
    .trim();
  if (/authorization|bearer |hashedtoken|eyJ[A-Za-z0-9]/i.test(text)) return "Agent gateway failed";
  return text.slice(0, 400) || "Agent gateway failed";
}
