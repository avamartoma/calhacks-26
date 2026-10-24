import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Room } from './types';

export interface CodexCliIntegration { command: string; script: string; url: string }

// Double quotes work for paths in both PowerShell and POSIX shells; these characters would end or expand them.
const shellSafe = (text: string) => text.replace(/["`$\\]/g, '');

/** A Codex CLI session the user runs themselves reports into this room over MCP, on its own ChatGPT sign-in. */
export function CodexSessionPanel({ room, codex }: { room: Room; codex: CodexCliIntegration | null }) {
  const [copied, setCopied] = useState(''); const [error, setError] = useState('');
  async function copy(text: string, kind: string) { try { await navigator.clipboard.writeText(text); setCopied(kind); setError(''); } catch { setError('Clipboard unavailable. Copy the command from Codex CLI setup instead.'); } }
  const outcome = sessionStorage.getItem(`iteration1-mission:${room.id}`)?.trim();
  const sessionPrompt = `Use Iteration1 for ${room.path}. ${room.demo ? 'Call office_open and office_status to inspect the live workspace.' : `Call office_status with roomId ${room.id} to inspect this office.`} Show existing work and blockers before starting. When I ask you to implement, claim ownership with office_codex_start, publish progress with office_codex_update, and call office_codex_finish after execution ends. Report your model id only if known. Do not edit alongside an active office writer.${outcome ? ` Requested outcome: ${outcome}` : ''}`;
  const addCommand = codex ? `codex mcp add iteration1 --env ITERATION1_PROJECT="${shellSafe(room.path)}" --env ITERATION1_URL=${codex.url} -- "${shellSafe(codex.command)}" "${shellSafe(codex.script)}"` : '';
  const startCommand = `cd "${shellSafe(room.path)}"; codex "${shellSafe(sessionPrompt)}"`;
  const toml = codex ? `[mcp_servers.iteration1]\ncommand = ${JSON.stringify(codex.command)}\nargs = [${JSON.stringify(codex.script)}]\nenv = { ITERATION1_PROJECT = ${JSON.stringify(room.path)}, ITERATION1_URL = ${JSON.stringify(codex.url)} }` : '';
  const reporting = room.agents.find(a => a.provider === 'codex-cli' && a.turnId);
  return <details className="compact-disclosure"><summary>Use an existing Codex CLI session</summary>
    {error && <p className="notice error" role="alert">{error}</p>}
    {copied && <span className="sr-only" role="status">Copied</span>}
    <p>Work in the <b>Codex CLI</b> with its own ChatGPT sign-in. It reports into this office over MCP, so nothing secret goes in its configuration.</p>
    {reporting && <p className="notice">{reporting.name} is reporting from the Codex CLI.</p>}
    <ol className="claude-steps">
      <li>Connect this project. Run in a terminal:
        <button className="primary full" disabled={!codex} onClick={() => void copy(addCommand, 'add')}>{copied === 'add' ? <Check size={16} /> : <Copy size={16} />} {copied === 'add' ? 'Command copied' : 'Copy connect command'}</button></li>
      <li>Start Codex with the office prompt:
        <button className="secondary full" onClick={() => void copy(startCommand, 'start')}>{copied === 'start' ? <Check size={16} /> : <Copy size={16} />} {copied === 'start' ? 'Command copied' : 'Copy start command'}</button></li>
    </ol>
    <p className="muted small">The connection is saved in your own Codex configuration and points at this project; run the connect command again to switch projects. Choose models and stop work in Codex.</p>
    <details className="compact-disclosure"><summary>Codex CLI setup</summary>
      <p>Instead of the command, add this to <code>~/.codex/config.toml</code>.</p>
      {codex ? <><button className="secondary full" onClick={() => void copy(toml, 'toml')}>{copied === 'toml' ? <Check size={15} /> : <Copy size={15} />} {copied === 'toml' ? 'Copied' : 'Copy configuration'}</button><textarea aria-label="Codex MCP configuration" className="integration-config" readOnly rows={5} value={toml} /></> : <p>Loading configuration…</p>}
      <label>Prompt<textarea readOnly rows={3} value={sessionPrompt} /></label>
    </details>
  </details>;
}
