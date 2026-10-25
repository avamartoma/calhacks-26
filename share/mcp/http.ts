import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createAgentServer } from "./server";

function rpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1] ?? null;
}

async function withoutAuthorization(request: Request): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "DELETE") {
    return new Request(request.url, { method: request.method, headers });
  }
  return new Request(request.url, { method: request.method, headers, body: await request.arrayBuffer() });
}

/**
 * Streamable HTTP entry. A fresh stateless transport handles GET, POST, and DELETE.
 * The Authorization header is read once and removed before the transport copies headers.
 */
export async function handleMcp(request: Request): Promise<Response> {
  const projectId = new URL(request.url).searchParams.get("projectId")?.trim() ?? "";
  if (!projectId) return rpcError(400, "projectId query parameter is required");
  const token = bearerToken(request);
  if (!token) return rpcError(401, "Authorization Bearer token is required");
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createAgentServer(token, projectId);
  try {
    await server.connect(transport);
    return await transport.handleRequest(await withoutAuthorization(request));
  } catch {
    return rpcError(500, "Agent gateway failed");
  }
}
