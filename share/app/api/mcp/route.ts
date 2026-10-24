import { handleMcp } from "@/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleMcp(request);
}

export function POST(request: Request): Promise<Response> {
  return handleMcp(request);
}

export function DELETE(request: Request): Promise<Response> {
  return handleMcp(request);
}
