import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { callGateway, safeMessage, type GatewayCall } from "./gateway";

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

function failure(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: safeMessage(error) }] };
}

function formatResult(call: GatewayCall, result: Record<string, unknown>): string {
  if (call.tool === "list_files" && Array.isArray(result.paths)) {
    const paths = result.paths.filter((item): item is string => typeof item === "string");
    return paths.length > 0 ? paths.join("\n") : "(no files)";
  }
  if (call.tool === "read_file" && typeof result.content === "string") return result.content;
  if (call.tool === "write_file") return `Wrote ${call.path ?? "file"}`;
  if (call.tool === "delete_file") return `Deleted ${call.path ?? "file"}`;
  if (call.tool === "get_preview_url") {
    return typeof result.previewUrl === "string" && result.previewUrl.length > 0 ? result.previewUrl : "Preview is not running";
  }
  if (call.tool === "run_command") {
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const code = typeof result.code === "number" ? result.code : 1;
    const parts = [stdout];
    if (stderr) parts.push(stderr);
    if (code !== 0) parts.push(`exit ${code}`);
    return parts.filter((part) => part.length > 0).join("\n") || `exit ${code}`;
  }
  return JSON.stringify(result);
}

async function run(call: GatewayCall): Promise<ToolResult> {
  try {
    return text(formatResult(call, await callGateway(call)));
  } catch (error) {
    return failure(error);
  }
}

/** Stateless MCP server bound to one bearer token and one project. The token stays in this closure. */
export function createAgentServer(token: string, projectId: string): McpServer {
  const server = new McpServer({ name: "iteration1", version: "1.0.0" });
  const base = { token, projectId };

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: "List workspace files. Uses git ls-files when the sandbox is a git repo, and skips node_modules and .git.",
    },
    async () => run({ ...base, tool: "list_files" }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read a file from the project sandbox. Path is relative to the workspace.",
      inputSchema: { path: z.string().describe("Workspace-relative file path") },
    },
    async ({ path }) => run({ ...base, tool: "read_file", path }),
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description: "Write a file in the project sandbox. Fails when another live session holds the file.",
      inputSchema: {
        path: z.string().describe("Workspace-relative file path"),
        content: z.string().describe("Full file contents"),
      },
    },
    async ({ path, content }) => run({ ...base, tool: "write_file", path, content }),
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete file",
      description: "Delete a file from the project sandbox. Fails when another live session holds the file.",
      inputSchema: { path: z.string().describe("Workspace-relative file path") },
    },
    async ({ path }) => run({ ...base, tool: "delete_file", path }),
  );

  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description: "Run a shell command in the project sandbox workspace.",
      inputSchema: { command: z.string().describe("Shell command to run in the workspace") },
    },
    async ({ command }) => run({ ...base, tool: "run_command", command }),
  );

  server.registerTool(
    "get_preview_url",
    {
      title: "Get preview URL",
      description: "Return the live preview URL for the project's sandbox session.",
    },
    async () => run({ ...base, tool: "get_preview_url" }),
  );

  return server;
}
