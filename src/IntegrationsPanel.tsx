import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import type { Room } from './types';
import './integrations.css';
import { ClaudePanel, type ClaudeIntegration } from './ClaudePanel';

interface Integrations { cursor: { command: string; script: string; url: string }; claude: ClaudeIntegration }
interface Identity { sub: string; label: string; record: { started: number; review: number; blocked: number; verified: number } }
export function IntegrationsPanel({ room }: { room: Room }) {
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState(''); const [copied, setCopied] = useState('');
  const [issued, setIssued] = useState<{ token: string; identity: Identity } | null>(null);
  async function load() { setError(''); try { const res = await fetch('/api/integrations'); const body = await res.json(); if (!res.ok) throw new Error(body.error); setData(body); } catch { setError('Could not load the connection. Retry when the office is connected.'); } }
  useEffect(() => { void load(); }, []);
  async function copy(text: string, kind: string) { try { await navigator.clipboard.writeText(text); setCopied(kind); setError(''); } catch { setError('Clipboard unavailable. Open Connection setup to copy the prompt manually.'); } }
  async function issueIdentity() {
    setError('');
    try {
      const res = await fetch('/api/identities', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: `Cursor · ${room.name}` }) });
      const body = await res.json(); if (!res.ok) throw new Error(body.error);
      setIssued(body);
    } catch { setError('Could not issue an agent identity. Retry when the office is connected.'); }
  }
  const config = data ? JSON.stringify({ mcpServers: { iteration1: { type: 'stdio', command: data.cursor.command, args: [data.cursor.script], env: { ITERATION1_PROJECT: room.path, ITERATION1_URL: data.cursor.url, ...(issued ? { ITERATION1_AGENT_TOKEN: issued.token } : {}) } } } }, null, 2) : '';
  const outcome=sessionStorage.getItem(`iteration1-mission:${room.id}`)?.trim();
  const prompt = `Use Iteration1 for ${room.path}. ${room.demo ? 'Call office_open and office_status to inspect the live workspace.' : `Call office_status with roomId "${room.id}" to inspect this office.`} Show existing work and blockers before starting. When I ask you to implement, claim ownership with office_cursor_start, publish progress with office_cursor_update, and call office_cursor_finish after execution ends. Report your actual model only if known. Do not edit alongside an active office writer.${outcome?` Requested outcome: ${outcome}`:''}`;
  return <div className="integrations-panel">
    <h2>Cursor</h2>
    {error && <p className="notice error" role="alert">{error}</p>}
    {copied && <span className="sr-only" role="status">{copied === 'prompt' ? 'Prompt copied' : 'Configuration copied'}</span>}
    {outcome && <p className="notice">Outcome: {outcome}</p>}<p>Open this folder in Cursor and enable <b>iteration1</b> in MCP settings. Then send the prepared prompt.</p>
    <a className="primary full" href={`cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`}><ArrowUpRight size={16} /> Continue in Cursor</a>
    <button className="text-button" onClick={() => void copy(prompt, 'prompt')}>{copied === 'prompt' ? <Check size={15} /> : <Copy size={15} />} {copied === 'prompt' ? 'Prompt copied' : 'Copy prompt'}</button>
    {room.demo && <p className="notice">The prompt opens a live room; this demo stays separate.</p>}
    <p className="muted small">Manage models and execution in Cursor.</p>
    <details className="compact-disclosure"><summary>Agent identity</summary>
      <p>Runs published without an identity stay unattributed: they appear in the office but build no profile. Issue one to give this Cursor session a durable desk and track record.</p>
      {issued
        ? <><p className="notice">Issued to <b>{issued.identity.label}</b>. The token is shown once; reissue if it is lost. It is now included in the configuration below.</p>
            <label>Agent token<textarea aria-label="Agent token" readOnly rows={2} value={issued.token} /></label>
            <button className="text-button" onClick={() => void copy(issued.token, 'token')}>{copied === 'token' ? <Check size={15} /> : <Copy size={15} />} {copied === 'token' ? 'Token copied' : 'Copy token'}</button></>
        : <button className="secondary full" onClick={() => void issueIdentity()}>Issue agent identity</button>}
    </details>
    <details className="compact-disclosure"><summary>Connection setup</summary>
      <p>If the connection is missing, merge this entry into <code>.cursor/mcp.json</code>. Keep existing servers.</p>
      {data ? <><button className="secondary full" onClick={() => void copy(config, 'config')}>{copied === 'config' ? <Check size={15} /> : <Copy size={15} />} {copied === 'config' ? 'Copied' : 'Copy configuration'}</button><textarea aria-label="Cursor MCP configuration" className="integration-config" readOnly rows={8} value={config} /></> : <p>{error ? 'Configuration unavailable.' : 'Loading configuration…'}</p>}
      <label>Prompt<textarea readOnly rows={3} value={prompt}/></label>
      <button className="text-button" onClick={() => void load()}>Refresh connection details</button>
    </details>
    <ClaudePanel room={room} claude={data?.claude ?? null} onChange={() => void load()} />
  </div>;
}
