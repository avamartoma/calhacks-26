// Claude Code's stream-json output, turned into the lines the office shows for a run.

export type RunLine = { kind: "text" | "tool" | "result" | "error"; text: string };
export type RunResult = { isError: boolean; text: string; costUsd?: number };

function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  const pick = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : "");
  const detail = pick("command") || pick("file_path") || pick("path") || pick("pattern") || pick("url") || pick("description") || JSON.stringify(input ?? {});
  return `${name}: ${detail.replace(/\s+/g, " ").slice(0, 300)}`;
}

/** Turns Claude Code's stream-json lines into what the office shows. */
export function parseStream(text: string): { lines: RunLine[]; result: RunResult | null } {
  const lines: RunLine[] = [];
  let result: RunResult | null = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let event: { type?: string; message?: { content?: unknown }; result?: unknown; is_error?: unknown; total_cost_usd?: unknown; subtype?: unknown };
    try { event = JSON.parse(raw); } catch { lines.push({ kind: "text", text: raw.slice(0, 1000) }); continue; }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content as { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
        if (block.type === "text" && block.text?.trim()) lines.push({ kind: "text", text: block.text.trim() });
        if (block.type === "tool_use" && block.name) lines.push({ kind: "tool", text: toolSummary(block.name, block.input) });
      }
    }
    if (event.type === "result") {
      const isError = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
      const body = typeof event.result === "string" ? event.result : isError ? `Stopped: ${String(event.subtype ?? "error")}` : "Done";
      result = { isError, text: body, ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}) };
      lines.push({ kind: isError ? "error" : "result", text: body });
    }
  }
  return { lines, result };
}

