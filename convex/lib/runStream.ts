// What Codex, Claude Code and Cursor print as JSON while they work, turned into the lines the
// office shows for a run. Claude Code and Cursor share a stream-json shape; Codex prints events.

export type RunLine = { kind: "text" | "tool" | "result" | "error"; text: string };
export type RunResult = { isError: boolean; text: string; costUsd?: number };
type Event = Record<string, unknown> & { type?: string };

const str = (value: unknown) => (typeof value === "string" ? value : "");
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);
/** Codex's errors end with the request's URL and IDs; people only need the reason. */
const codexReason = (text: string) => text.replace(/^unexpected status \d+ [A-Za-z ]+: /, "").split(/, url: /)[0].trim();
/** Codex reports each retry as an error event before the real failure. */
const codexRetry = (text: string) => /^(Reconnecting\.\.\.|Falling back from WebSockets)/.test(text);

function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  const detail = str(input?.command) || str(input?.file_path) || str(input?.path) || str(input?.pattern) || str(input?.url) || str(input?.query) || str(input?.description) || JSON.stringify(input ?? {});
  return `${name}: ${oneLine(detail)}`;
}

/** Cursor names a tool call by its key, like `shellToolCall` or `editToolCall`. */
function cursorTool(call: unknown): string | null {
  if (!call || typeof call !== "object") return null;
  const [key, body] = Object.entries(call as Record<string, { args?: Record<string, unknown>; name?: string; arguments?: string }>)[0] ?? [];
  if (!key) return null;
  if (key === "function") return `${body?.name || "Tool"}: ${oneLine(body?.arguments || "")}`;
  const name = key.replace(/ToolCall$/, "");
  return toolSummary(name.charAt(0).toUpperCase() + name.slice(1), body?.args);
}

/** Codex's finished items: what it said, ran, changed, searched or called. */
function codexItem(item: Record<string, unknown>): RunLine | null {
  switch (item.type) {
    case "agent_message": return str(item.text).trim() ? { kind: "text", text: str(item.text).trim() } : null;
    case "command_execution": return { kind: "tool", text: `Shell: ${oneLine(str(item.command))}` };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? (item.changes as { path?: string; kind?: string }[]) : [];
      return { kind: "tool", text: `Edit: ${oneLine(changes.map((change) => change.path).filter(Boolean).join(", ") || "files")}` };
    }
    case "mcp_tool_call": return { kind: "tool", text: `${str(item.server) || "MCP"}: ${str(item.tool)}` };
    case "web_search": return { kind: "tool", text: `Search: ${oneLine(str(item.query))}` };
    case "error": return codexRetry(str(item.message)) ? null : { kind: "error", text: codexReason(str(item.message)) || "Codex reported an error" };
    default: return null;
  }
}

/**
 * `session` is the agent's own conversation id, for resuming it with a follow-up: Claude Code and
 * Cursor send `session_id`, Codex starts with `thread.started` and a `thread_id`.
 */
export function parseStream(text: string, agent: "codex" | "claude" | "cursor" = "claude"): { lines: RunLine[]; result: RunResult | null; session: string | null } {
  const lines: RunLine[] = [];
  let result: RunResult | null = null;
  let session: string | null = null;
  let lastMessage = "";
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let event: Event;
    try { event = JSON.parse(raw); } catch { lines.push({ kind: "text", text: raw.slice(0, 1000) }); continue; }
    const id = str(event.session_id) || (event.type === "thread.started" ? str(event.thread_id) : "");
    if (id && /^[A-Za-z0-9_-]{6,100}$/.test(id)) session = id;
    if (agent === "codex") {
      if (event.type === "item.completed" && event.item && typeof event.item === "object") {
        const line = codexItem(event.item as Record<string, unknown>);
        if (line) { lines.push(line); if (line.kind === "text") lastMessage = line.text; }
      }
      if (event.type === "turn.completed") {
        result = { isError: false, text: lastMessage || "Done" };
        lines.push({ kind: "result", text: "Done" });
      }
      if (event.type === "turn.failed" || event.type === "error") {
        const raw = str((event.error as { message?: unknown } | undefined)?.message) || str(event.message);
        if (codexRetry(raw)) continue;
        const message = codexReason(raw) || "Codex stopped with an error";
        result = { isError: true, text: message };
        if (lines[lines.length - 1]?.text !== message) lines.push({ kind: "error", text: message });
      }
      continue;
    }
    const message = event.message as { content?: unknown } | undefined;
    if (event.type === "assistant" && Array.isArray(message?.content)) {
      for (const block of message.content as { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (block.type === "text" && block.text?.trim()) lines.push({ kind: "text", text: block.text.trim() });
        if (block.type === "tool_use" && block.name) lines.push({ kind: "tool", text: toolSummary(block.name, block.input) });
      }
    }
    if (event.type === "tool_call" && event.subtype === "started") {
      const summary = cursorTool(event.tool_call);
      if (summary) lines.push({ kind: "tool", text: summary });
    }
    if (event.type === "result") {
      const isError = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
      const body = str(event.result) || (isError ? `Stopped: ${str(event.subtype) || "error"}` : "Done");
      result = { isError, text: body, ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}) };
      lines.push({ kind: isError ? "error" : "result", text: body });
    }
  }
  return { lines, result, session };
}
