import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import type { Room } from './types';
import './integrations.css';

interface Integrations { cursor: { command: string; script: string; url: string } }
export function IntegrationsPanel({ room }: { room: Room }) {
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState(''); const [copied, setCopied] = useState('');
  async function load() { setError(''); try { const res = await fetch('/api/integrations'); const body = await res.json(); if (!res.ok) throw new Error(body.error); setData(body); } catch { setError('Could not load the connection. Retry when the office is connected.'); } }
  useEffect(() => { void load(); }, []);
  async function copy(text: string, kind: string) { try { await navigator.clipboard.writeText(text); setCopied(kind); setError(''); } catch { setError('Clipboard unavailable. Open Connection setup to copy the prompt manually.'); } }
  const config = data ? JSON.stringify({ mcpServers: { fourteenth: { type: 'stdio', command: data.cursor.command, args: [data.cursor.script], env: { FOURTEENTH_PROJECT: room.path, FOURTEENTH_URL: data.cursor.url } } } }, null, 2) : '';
  const outcome=sessionStorage.getItem(`fourteenth-mission:${room.id}`)?.trim();
  const prompt = `Use Fourteenth for ${room.path}. ${room.demo ? 'Call office_open and office_status to inspect the live workspace.' : `Call office_status with roomId "${room.id}" to inspect this office.`} Show existing work and blockers before starting. When I ask you to implement, claim ownership with office_cursor_start, publish progress with office_cursor_update, and call office_cursor_finish after execution ends. Report your actual model only if known. Do not edit alongside an active office writer.${outcome?` Requested outcome: ${outcome}`:''}`;
  return <div className="integrations-panel">
    <h2>Cursor</h2>
    {error && <p className="notice error" role="alert">{error}</p>}
    {copied && <span className="sr-only" role="status">{copied === 'prompt' ? 'Prompt copied' : 'Configuration copied'}</span>}
    {outcome && <p className="notice">Outcome: {outcome}</p>}<p>Open this folder in Cursor and enable <b>fourteenth</b> in MCP settings. Then send the prepared prompt.</p>
    <a className="primary full" href={`cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`}><ArrowUpRight size={16} /> Continue in Cursor</a>
    <button className="text-button" onClick={() => void copy(prompt, 'prompt')}>{copied === 'prompt' ? <Check size={15} /> : <Copy size={15} />} {copied === 'prompt' ? 'Prompt copied' : 'Copy prompt'}</button>
    {room.demo && <p className="notice">The prompt opens a live room; this demo stays separate.</p>}
    <p className="muted small">Manage models and execution in Cursor.</p>
    <details className="compact-disclosure"><summary>Connection setup</summary>
      <p>If the connection is missing, merge this entry into <code>.cursor/mcp.json</code>. Keep existing servers.</p>
      {data ? <><button className="secondary full" onClick={() => void copy(config, 'config')}>{copied === 'config' ? <Check size={15} /> : <Copy size={15} />} {copied === 'config' ? 'Copied' : 'Copy configuration'}</button><textarea aria-label="Cursor MCP configuration" className="integration-config" readOnly rows={8} value={config} /></> : <p>{error ? 'Configuration unavailable.' : 'Loading configuration…'}</p>}
      <label>Prompt<textarea readOnly rows={3} value={prompt}/></label>
      <button className="text-button" onClick={() => void load()}>Refresh connection details</button>
    </details>
  </div>;
}
