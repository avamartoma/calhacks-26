import { useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, Copy, ExternalLink, KeyRound, LoaderCircle, Play } from 'lucide-react';
import type { Room } from './types';

export interface ClaudeIntegration { configured: boolean; source: 'environment' | 'saved' | null; hint: string | null; models: { id: string; name: string }[] }
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
 * needed. Launching Claude Agent SDK runs from the office itself still takes an Anthropic API key.
 */
export function ClaudePanel({ room, claude, code, onChange, focus = 0 }: { room: Room; claude: ClaudeIntegration | null; code: ClaudeCodeIntegration | null; onChange: () => void; focus?: number }) {
  const [apiKey, setApiKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('claude-opus-5-5');
  const [access, setAccess] = useState<'edit' | 'read'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [copied, setCopied] = useState('');
  const connectButton = useRef<HTMLButtonElement>(null); const section = useRef<HTMLHeadingElement>(null);
  // Arriving from the top bar: bring Claude into view, ready to copy the connect command.
  useEffect(() => { if (!focus) return; section.current?.scrollIntoView({ block: 'start' }); connectButton.current?.focus(); }, [focus]);
  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setError(''); setNotice('');
    try { const message = await fn(); if (message) setNotice(message); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function copy(text: string, kind: string) { try { await navigator.clipboard.writeText(text); setCopied(kind); setError(''); } catch { setError('Clipboard unavailable. Copy the command from Connection setup instead.'); } }
  const connect = (key = apiKey) => run(async () => { await post('/api/claude/key', { apiKey: key }); setApiKey(''); onChange(); return 'Claude connected.'; });
  const disconnect = () => run(async () => { await post('/api/claude/key/remove', {}); onChange(); return 'Claude disconnected. The key was removed from this computer.'; });
  const launch = () => run(async () => {
    const body = await post(`/api/rooms/${room.id}/claude/launch`, { prompt, model, access });
    setPrompt(''); return `Launched on ${claude?.models.find(m => m.id === body.model)?.name || body.model}. Follow it at its desk.`;
  });

  const outcome = sessionStorage.getItem(`iteration1-mission:${room.id}`)?.trim();
  const sessionPrompt = `Use Iteration1 for ${room.path}. ${room.demo ? 'Call office_open and office_status to inspect the live workspace.' : `Call office_status with roomId ${room.id} to inspect this office.`} Show existing work and blockers before starting. When I ask you to implement, claim ownership with office_claude_start, publish progress with office_claude_update, and call office_claude_finish after execution ends. Report your model id only if your environment states it. Do not edit alongside an active office writer.${outcome ? ` Requested outcome: ${outcome}` : ''}`;
  const addCommand = code ? `cd "${shellSafe(room.path)}"; claude mcp add iteration1 --scope project --env ITERATION1_PROJECT="${shellSafe(room.path)}" --env ITERATION1_URL=${code.url} -- "${shellSafe(code.command)}" "${shellSafe(code.script)}"` : '';
  const startCommand = `cd "${shellSafe(room.path)}"; claude "${shellSafe(sessionPrompt)}"`;
  const mcpJson = code ? JSON.stringify({ mcpServers: { iteration1: { type: 'stdio', command: code.command, args: [code.script], env: { ITERATION1_PROJECT: room.path, ITERATION1_URL: code.url } } } }, null, 2) : '';
  const reporting = room.agents.find(a => a.provider === 'claude-code' && a.turnId);

  return <>
    <h2 ref={section}>Claude</h2>
    {error && <p className="notice error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {copied && <span className="sr-only" role="status">Copied</span>}
    <p>Work in <b>Claude Code</b> with your own Claude sign-in. It reports into this office over MCP, so no API key is needed and nothing secret goes in <code>.mcp.json</code>.</p>
    {reporting && <p className="notice">{reporting.name} is reporting from Claude Code.</p>}
    <ol className="claude-steps">
      <li>Connect this project once. Run in a terminal:
        <button ref={connectButton} className="primary full" disabled={!code} onClick={() => void copy(addCommand, 'add')}>{copied === 'add' ? <Check size={16} /> : <Copy size={16} />} {copied === 'add' ? 'Command copied' : 'Copy connect command'}</button></li>
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

    <details className="compact-disclosure" open={!!claude?.configured}><summary>Launch from the office (API key)</summary>
    {!claude ? <p>Loading…</p>
      : !claude.configured ? <>
        <p>To have the office launch and stop Claude agents itself, connect an Anthropic API key, billed to that account. It connects as soon as you paste.</p>
        <a className="secondary full" href={CLAUDE_KEYS_URL} target="_blank" rel="noreferrer"><KeyRound size={16} /> Create an API key <ExternalLink size={14} /></a>
        <form onSubmit={e => { e.preventDefault(); void connect(); }}>
          <label>API key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy} onChange={e => setApiKey(e.target.value)} onPaste={e => { const text = e.clipboardData.getData('text').trim(); if (looksLikeKey(text)) { e.preventDefault(); setApiKey(text); void connect(text); } }} placeholder="Paste your key (sk-ant-…)" /></label>
          <button className="primary full" disabled={busy || !apiKey.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <CheckCheck size={16} />} {busy ? 'Checking key…' : 'Connect key'}</button>
        </form>
        <p className="muted small">The key is checked with Anthropic, then saved only on this computer. It is never shown again.</p>
      </>
      : <>
        <div className="account-info"><CheckCheck size={22} /><div><b>API key connected</b><small>{claude.source === 'environment' ? `Using ANTHROPIC_API_KEY (${claude.hint})` : `API key ${claude.hint}`}</small></div></div>
        {room.demo ? <p className="notice">Open a live project room to launch Claude agents.</p> : <>
          <p>Launch a Claude agent at a new desk. It works in <code>{room.path}</code>. Message it at its desk to steer or continue it.</p>
          <label>Task<textarea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe the work" /></label>
          <label>Model<select value={model} onChange={e => setModel(e.target.value)}>{claude.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label>Access<select value={access} onChange={e => setAccess(e.target.value as 'edit' | 'read')}>
            <option value="edit">Edit files and run sandboxed commands</option>
            <option value="read">Read only</option>
          </select></label>
          <button className="primary full" disabled={busy || !prompt.trim()} onClick={() => void launch()}><Play size={16} /> {busy ? 'Launching…' : 'Launch Claude agent'}</button>
        </>}
        {claude.source === 'saved' && <button className="text-button" disabled={busy} onClick={() => void disconnect()}>Disconnect key</button>}
      </>}
    </details>
  </>;
}
