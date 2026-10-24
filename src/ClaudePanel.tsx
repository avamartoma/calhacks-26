import { useState } from 'react';
import { ArrowRight, Check, CheckCheck, Copy, ExternalLink, KeyRound, LoaderCircle } from 'lucide-react';
import type { Room } from './types';
import { ProviderConnection } from './ProviderConnection';

export interface ClaudeIntegration { configured: boolean; source: 'environment' | 'saved' | null; hint: string | null; models: { id: string; name: string }[]; subscription?: { configured: boolean } }
export interface ClaudeCodeIntegration { command: string; script: string; url: string }

export const CLAUDE_KEYS_URL = 'https://platform.claude.com/settings/keys';
const looksLikeKey = (text: string) => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(text.trim());
// Double quotes work for paths in both PowerShell and POSIX shells; these characters would end or expand them.
const shellSafe = (text: string) => text.replace(/["`$\\]/g, '');

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error);
  return data;
}

/**
 * Claude Code reports into this room over MCP and runs on its own Claude sign-in, so no key is
 * needed. With the office's own Claude profile or an API key, Claude also runs office agents
 * like Codex: choose a Claude model for the manager or any agent.
 */
export function ClaudePanel({ room, claude, code, onChange, onStartWork }: { room: Room; claude: ClaudeIntegration | null; code: ClaudeCodeIntegration | null; onChange: () => void; onStartWork?: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [copied, setCopied] = useState('');
  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setError(''); setNotice('');
    try { const message = await fn(); if (message) setNotice(message); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function copy(text: string, kind: string) { try { await navigator.clipboard.writeText(text); setCopied(kind); setError(''); } catch { setError('Clipboard unavailable. Copy the command from Connection setup instead.'); } }
  const connect = (key = apiKey) => run(async () => { await post('/api/claude/key', { apiKey: key }); setApiKey(''); onChange(); return 'Claude connected.'; });
  const disconnect = () => run(async () => { await post('/api/claude/key/remove', {}); onChange(); return 'Claude disconnected. The key was removed from this computer.'; });

  const outcome = sessionStorage.getItem(`iteration1-mission:${room.id}`)?.trim();
  const sessionPrompt = `Use Iteration1 for ${room.path}. ${room.demo ? 'Call office_open and office_status to inspect the live workspace.' : `Call office_status with roomId ${room.id} to inspect this office.`} Show existing work and blockers before starting. When I ask you to implement, claim ownership with office_claude_start, publish progress with office_claude_update, and call office_claude_finish after execution ends. Report your model id only if your environment states it. Do not edit alongside an active office writer.${outcome ? ` Requested outcome: ${outcome}` : ''}`;
  const addCommand = code ? `cd "${shellSafe(room.path)}"; claude mcp add iteration1 --scope project --env ITERATION1_PROJECT="${shellSafe(room.path)}" --env ITERATION1_URL=${code.url} -- "${shellSafe(code.command)}" "${shellSafe(code.script)}"` : '';
  const startCommand = `cd "${shellSafe(room.path)}"; claude "${shellSafe(sessionPrompt)}"`;
  const mcpJson = code ? JSON.stringify({ mcpServers: { iteration1: { type: 'stdio', command: code.command, args: [code.script], env: { ITERATION1_PROJECT: room.path, ITERATION1_URL: code.url } } } }, null, 2) : '';
  const reporting = room.agents.find(a => a.provider === 'claude-code' && a.turnId);
  const subscription = !!claude?.subscription?.configured && claude?.source !== 'environment';
  const ready = subscription || !!claude?.configured;

  return <>
    <h3 className="provider-title">Claude</h3>
    <ProviderConnection provider="claude" onChange={onChange} />
    {error && <p className="notice error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {copied && <span className="sr-only" role="status">Copied</span>}
    <details className="compact-disclosure"><summary>Use an existing Claude Code session</summary>
    <p>Work in <b>Claude Code</b> with your own Claude sign-in. It reports into this office over MCP, so no API key is needed and nothing secret goes in <code>.mcp.json</code>.</p>
    {reporting && <p className="notice">{reporting.name} is reporting from Claude Code.</p>}
    <ol className="claude-steps">
      <li>Connect this project once. Run in a terminal:
        <button className="primary full" disabled={!code} onClick={() => void copy(addCommand, 'add')}>{copied === 'add' ? <Check size={16} /> : <Copy size={16} />} {copied === 'add' ? 'Command copied' : 'Copy connect command'}</button></li>
      <li>Start Claude Code with the office prompt:
        <button className="secondary full" onClick={() => void copy(startCommand, 'start')}>{copied === 'start' ? <Check size={16} /> : <Copy size={16} />} {copied === 'start' ? 'Command copied' : 'Copy start command'}</button></li>
    </ol>
    {room.demo && <p className="notice">The prompt opens a live room; this demo stays separate.</p>}
    <p className="muted small">Choose models and stop work in Claude Code. In this repository, <code>/office</code> runs the same prompt.</p>
    <details className="compact-disclosure"><summary>Claude Code setup</summary>
      <p>Instead of the command, merge this entry into <code>.mcp.json</code> at the project root. Keep existing servers.</p>
      {code ? <><button className="secondary full" onClick={() => void copy(mcpJson, 'json')}>{copied === 'json' ? <Check size={15} /> : <Copy size={15} />} {copied === 'json' ? 'Copied' : 'Copy configuration'}</button><textarea aria-label="Claude Code MCP configuration" className="integration-config" readOnly rows={8} value={mcpJson} /></> : <p>Loading configuration…</p>}
      <label>Prompt<textarea readOnly rows={3} value={sessionPrompt} /></label>
    </details>
    </details>

    <details className="compact-disclosure" open={ready}><summary>Run Claude agents in the office</summary>
    {!claude ? <p>Loading…</p>
      : !ready ? <>
        <p>Sign in above, or connect an Anthropic API key billed to that account.</p>
        <a className="secondary full" href={CLAUDE_KEYS_URL} target="_blank" rel="noreferrer"><KeyRound size={16} /> Create an API key <ExternalLink size={14} /></a>
        <form onSubmit={e => { e.preventDefault(); void connect(); }}>
          <label>API key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy} onChange={e => setApiKey(e.target.value)} onPaste={e => { const text = e.clipboardData.getData('text').trim(); if (looksLikeKey(text)) { e.preventDefault(); setApiKey(text); void connect(text); } }} placeholder="Paste your key (sk-ant-…)" /></label>
          <button className="primary full" disabled={busy || !apiKey.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <CheckCheck size={16} />} {busy ? 'Checking key…' : 'Connect key'}</button>
        </form>
        <p className="muted small">The key is checked with Anthropic, then saved only on this computer. It is never shown again.</p>
      </>
      : <>
        <div className="account-info"><CheckCheck size={22} /><div><b>{subscription ? 'Claude account connected' : 'API key connected'}</b><small>{subscription ? 'Using the Iteration1 Claude Code profile' : claude.source === 'environment' ? `Using ANTHROPIC_API_KEY (${claude.hint})` : `API key ${claude.hint}`}</small></div></div>
        <p>Claude agents work in the office like Codex agents: a Claude manager plans, delegates to Claude workers, edits, runs checks and hands off through tickets. Choose a Claude model as the <b>Manager model</b> when you start work, or when you replace any agent.</p>
        {room.demo ? <p className="notice">Open a live project room to run Claude agents.</p> : onStartWork && <button className="primary full" onClick={onStartWork}><ArrowRight size={16} /> Start work with Claude</button>}
        {claude.source === 'saved' && <button className="text-button" disabled={busy} onClick={() => void disconnect()}>Disconnect key</button>}
      </>}
    </details>
  </>;
}
