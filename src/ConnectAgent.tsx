import { useEffect, useState } from "react";
import { ConvexHttpClient } from "convex/browser";
import { Check, Copy } from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import "./connect-agent.css";
import hosted from "../hosted.json";

const DEFAULT_CONVEX_URL = hosted.convexUrl;
const DEFAULT_SHARE_ORIGIN = hosted.shareOrigin;

type Issued = {
  id: Id<"tokens">;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
};

function envValue(name: string): string | undefined {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const value = env?.[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function convexClient(): ConvexHttpClient {
  return new ConvexHttpClient(envValue("VITE_CONVEX_URL") || DEFAULT_CONVEX_URL, { logger: false });
}

function mcpUrl(projectId: string): string {
  const origin = (envValue("VITE_SHARE_ORIGIN") || DEFAULT_SHARE_ORIGIN).replace(/\/$/, "");
  return `${origin}/api/mcp?projectId=${encodeURIComponent(projectId)}`;
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return "Could not reach Convex.";
  const uncaught = error.message.split("\n").find((line) => line.includes("Uncaught Error:"));
  const text = (uncaught ?? error.message.split("\n")[0] ?? "Could not reach Convex.")
    .replace(/^\[CONVEX [^\]]+\]\s*/, "")
    .replace(/^(Uncaught )?Error:\s*/, "")
    .trim();
  return text.slice(0, 400) || "Could not reach Convex.";
}

export function ConnectAgent({ projectId }: { projectId?: string }) {
  const [label, setLabel] = useState("");
  const [tokens, setTokens] = useState<Issued[]>([]);
  const [revealed, setRevealed] = useState<{ token: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");

  async function refresh(id: string) {
    const rows = await convexClient().query(api.agentTokens.list, { projectId: id as Id<"projects"> });
    setTokens(rows);
  }

  useEffect(() => {
    setRevealed(null);
    setTokens([]);
    setError("");
    if (!projectId) return;
    let cancel = false;
    void convexClient()
      .query(api.agentTokens.list, { projectId: projectId as Id<"projects"> })
      .then((rows) => {
        if (!cancel) setTokens(rows);
      })
      .catch((cause: unknown) => {
        if (!cancel) setError(messageOf(cause));
      });
    return () => {
      cancel = true;
    };
  }, [projectId]);

  async function copy(text: string, kind: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setError("Clipboard unavailable. Select the text and copy it manually.");
    }
  }

  async function connect() {
    if (!projectId) return;
    setBusy("issue");
    setError("");
    try {
      const issued = await convexClient().mutation(api.agentTokens.issue, {
        projectId: projectId as Id<"projects">,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setRevealed({ token: issued.token, url: mcpUrl(projectId) });
      setLabel("");
      await refresh(projectId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }

  async function revoke(tokenId: Id<"tokens">) {
    if (!projectId) return;
    setBusy(tokenId);
    setError("");
    try {
      await convexClient().mutation(api.agentTokens.revoke, { tokenId });
      await refresh(projectId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  }

  const url = revealed?.url ?? (projectId ? mcpUrl(projectId) : "");
  const token = revealed?.token ?? "";
  const claude = token
    ? `claude mcp add --transport http iteration1 ${url} --header "Authorization: Bearer ${token}"`
    : `claude mcp add --transport http iteration1 ${url} --header "Authorization: Bearer <token>"`;
  const codex = `[mcp_servers.iteration1]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "ITERATION1_TOKEN"`;
  const cursor = JSON.stringify(
    { mcpServers: { iteration1: { url, headers: { Authorization: "Bearer ${env:ITERATION1_TOKEN}" } } } },
    null,
    2,
  );

  return (
    <section className="connect-agent">
      <h2>Connect an agent</h2>
      <p>Issue a personal token for this project. It is stored as a hash and shown once.</p>
      {!projectId && <p className="notice">Open a cloud project before connecting an agent.</p>}
      <label>
        Label
        <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={80} placeholder="Laptop Claude" disabled={!projectId} />
      </label>
      <button className="primary" type="button" disabled={!projectId || busy === "issue"} onClick={() => void connect()}>
        {busy === "issue" ? "Connecting…" : "Connect agent"}
      </button>
      {error && <p className="notice error" role="alert">{error}</p>}
      {revealed && (
        <div className="connect-reveal">
          <p>Copy this token now. It cannot be shown again. Put it in an environment variable, not in a chat and not in a committed file.</p>
          <label>
            Token
            <textarea readOnly rows={2} value={token} aria-label="Agent token" />
          </label>
          <button className="secondary" type="button" onClick={() => void copy(token, "token")}>
            {copied === "token" ? <Check size={15} /> : <Copy size={15} />} {copied === "token" ? "Token copied" : "Copy token"}
          </button>
          <p className="muted small">MCP URL. The host is the deployed share origin. This default is {DEFAULT_SHARE_ORIGIN}.</p>
          <textarea readOnly rows={2} value={url} aria-label="MCP URL" />
          <h3>Claude Code</h3>
          <p>Run this locally. The header is <code>Authorization: Bearer</code> and the command contains the token.</p>
          <textarea readOnly rows={3} value={claude} aria-label="Claude Code setup" />
          <button className="text-button" type="button" onClick={() => void copy(claude, "claude")}>
            {copied === "claude" ? <Check size={15} /> : <Copy size={15} />} {copied === "claude" ? "Command copied" : "Copy Claude command"}
          </button>
          <h3>Codex</h3>
          <p>Add this to <code>config.toml</code>. Put the token in <code>ITERATION1_TOKEN</code>, not in the file and not in the chat.</p>
          <textarea readOnly rows={4} value={codex} aria-label="Codex setup" />
          <button className="text-button" type="button" onClick={() => void copy(codex, "codex")}>
            {copied === "codex" ? <Check size={15} /> : <Copy size={15} />} {copied === "codex" ? "Config copied" : "Copy Codex config"}
          </button>
          <h3>Cursor</h3>
          <p>Merge this into your local MCP settings. The header reads <code>ITERATION1_TOKEN</code>. Do not write the token into a repo file.</p>
          <textarea readOnly rows={8} value={cursor} aria-label="Cursor setup" />
          <button className="text-button" type="button" onClick={() => void copy(cursor, "cursor")}>
            {copied === "cursor" ? <Check size={15} /> : <Copy size={15} />} {copied === "cursor" ? "Config copied" : "Copy Cursor config"}
          </button>
        </div>
      )}
      <h3>Revoke</h3>
      {tokens.length === 0 ? <p className="muted small">No tokens for this project yet.</p> : (
        <ul className="connect-tokens">
          {tokens.map((item) => (
            <li key={item.id}>
              <span>{item.label || "Untitled"}</span>
              <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
              {item.revokedAt ? <span>Revoked {new Date(item.revokedAt).toLocaleString()}</span> : (
                <button className="text-button" type="button" disabled={busy === item.id} onClick={() => void revoke(item.id)}>Revoke</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
