import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, Play } from 'lucide-react';
import type { OfficeState, Room } from './types';
import './integrations.css';
import { ClaudePanel, type ClaudeCodeIntegration, type ClaudeIntegration } from './ClaudePanel';
import { ProviderConnection } from './ProviderConnection';
import { CodexConnection } from './CodexConnection';
import { CodexSessionPanel, type CodexCliIntegration } from './CodexSession';

export type ConnectionProvider = 'codex' | 'claude' | 'cursor';
const providers: ConnectionProvider[] = ['codex', 'claude', 'cursor'];
const providerNames = { codex: 'Codex', claude: 'Claude', cursor: 'Cursor' };

interface Integrations { cursor: { command: string; script: string; url: string; account?: { configured: boolean } }; claudeCode: ClaudeCodeIntegration; codexCli?: CodexCliIntegration; claude: ClaudeIntegration }
interface Identity { sub: string; label: string; email?: string; record: { started: number; review: number; blocked: number; verified: number } }
interface Auth { provider: { domain: string; clientId: string; fromEnv: boolean } | null; signedIn: boolean; identity: Identity | null; redirectUri: string }
export function IntegrationsPanel({ room, connection, focus, onContinue, onStartWork }: { room: Room; connection: OfficeState['connection']; focus?: { provider: ConnectionProvider; request: number } | null; onContinue?: () => void; onStartWork?: () => void }) {
  const [selected, setSelected] = useState<ConnectionProvider>(focus?.provider || 'codex');
  const tabs = useRef<Partial<Record<ConnectionProvider, HTMLButtonElement | null>>>({});
  useEffect(() => { if (focus) { setSelected(focus.provider); tabs.current[focus.provider]?.focus({ preventScroll: true }); } }, [focus?.provider, focus?.request]);
  const [data, setData] = useState<Integrations | null>(null);
  const [error, setError] = useState(''); const [copied, setCopied] = useState('');
  const [auth, setAuth] = useState<Auth | null>(null);
  const [domain, setDomain] = useState(''); const [clientId, setClientId] = useState('');
  const [cursorPrompt, setCursorPrompt] = useState(''); const [cursorModel, setCursorModel] = useState('composer-2.5');
  const [launching, setLaunching] = useState(false); const [cursorNotice, setCursorNotice] = useState('');
  async function load() { setError(''); try { const res = await fetch('/api/integrations'); const body = await res.json(); if (!res.ok) throw new Error(body.error); setData(body); } catch { setError('Could not load the connection. Retry when the office is connected.'); } }
  useEffect(() => { void load(); }, [selected]);
  async function copy(text: string, kind: string) { try { await navigator.clipboard.writeText(text); setCopied(kind); setError(''); } catch { setError('Clipboard unavailable. Open Cursor connection setup to copy the prompt manually.'); } }
  async function post(route: string, body?: unknown) {
    const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    const payload = await res.json(); if (!res.ok) throw new Error(payload.error); return payload;
  }
  async function loadAuth() { try { setAuth(await (await fetch('/api/auth/session')).json()); } catch { /* the session panel stays hidden until the office answers */ } }
  useEffect(() => { void loadAuth(); }, []);
  async function connectProvider() {
    setError('');
    try { await post('/api/auth/provider', { domain: domain.trim(), clientId: clientId.trim() }); await loadAuth(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the Auth0 tenant.'); }
  }
  async function signIn() {
    setError('');
    // Auth0 is opened in a normal tab so an existing session signs in without typing anything.
    try { const { url } = await post('/api/auth/login'); window.open(url, '_blank', 'noopener'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start the sign-in.'); }
  }
  async function signOut() { setError(''); try { await post('/api/auth/logout'); await loadAuth(); } catch { setError('Could not sign out.'); } }
  const config = data ? JSON.stringify({ mcpServers: { iteration1: { type: 'stdio', command: data.cursor.command, args: [data.cursor.script], env: { ITERATION1_PROJECT: room.path, ITERATION1_URL: data.cursor.url } } } }, null, 2) : '';
  const outcome=sessionStorage.getItem(`iteration1-mission:${room.id}`)?.trim();
  const prompt = `Use Iteration1 for ${room.path}. ${room.demo ? 'Call office_open and office_status to inspect the live workspace.' : `Call office_status with roomId "${room.id}" to inspect this office.`} Show existing work and blockers before starting. When I ask you to implement, claim ownership with office_cursor_start, publish progress with office_cursor_update, and call office_cursor_finish after execution ends. Report your actual model only if known. Do not edit alongside an active office writer.${outcome?` Requested outcome: ${outcome}`:''}`;
  async function launchCursor() {
    setLaunching(true); setError(''); setCursorNotice('');
    try { await post(`/api/rooms/${room.id}/cursor/launch`, { prompt: cursorPrompt, model: cursorModel, runtime: 'local', autoCreatePR: false }); setCursorPrompt(''); setCursorNotice('Cursor launched. Follow its work at its desk.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not launch Cursor.'); }
    finally { setLaunching(false); }
  }
  const statuses = {
    codex: connection.signIn ? 'Signing in…' : connection.account ? 'Connected' : 'Not connected',
    claude: !data ? 'Checking…' : data.claude.configured || data.claude.subscription?.configured ? 'Connected' : 'Not connected',
    cursor: !data ? 'Checking…' : data.cursor.account?.configured ? 'Connected' : 'Not connected'
  };
  return <div className="integrations-panel connections-panel">
    <h2>Connections</h2>
    <p className="connections-intro">Manage the accounts used by your agents.</p>
    <div className="provider-tabs" role="tablist" aria-label="Provider accounts">
      {providers.map(provider => <button key={provider} ref={element => { tabs.current[provider] = element; }} type="button" role="tab" id={`connection-tab-${provider}`} aria-controls={`connection-panel-${provider}`} aria-selected={selected === provider} tabIndex={selected === provider ? 0 : -1} onClick={() => setSelected(provider)} onKeyDown={event => {
        const index = providers.indexOf(provider);
        const next = event.key === 'ArrowRight' ? providers[(index + 1) % providers.length] : event.key === 'ArrowLeft' ? providers[(index + providers.length - 1) % providers.length] : event.key === 'Home' ? providers[0] : event.key === 'End' ? providers.at(-1) : undefined;
        if (next) { event.preventDefault(); setSelected(next); tabs.current[next]?.focus(); }
      }}><span>{providerNames[provider]}</span><small>{statuses[provider]}</small></button>)}
    </div>
    <section className="provider-content" role="tabpanel" id={`connection-panel-${selected}`} aria-labelledby={`connection-tab-${selected}`} tabIndex={0}>
    {selected === 'codex' && <><CodexConnection connection={connection} onContinue={onContinue} /><CodexSessionPanel room={room} codex={data?.codexCli ?? null} /></>}
    {selected === 'claude' && <ClaudePanel room={room} claude={data?.claude ?? null} code={data?.claudeCode ?? null} onChange={() => void load()} onStartWork={onStartWork} />}
    {selected === 'cursor' && <>
    <h3 className="provider-title">Cursor</h3>
    <ProviderConnection provider="cursor" onChange={() => void load()} />
    {error && <p className="notice error" role="alert">{error}</p>}
    {copied && <span className="sr-only" role="status">{copied === 'prompt' ? 'Prompt copied' : 'Configuration copied'}</span>}
    {cursorNotice && <p className="notice" role="status">{cursorNotice}</p>}
    {data?.cursor.account?.configured && <details className="compact-disclosure"><summary>Launch Cursor from the office</summary>
      {room.demo ? <p>Open a live project to launch a Cursor agent.</p> : <>
        <p>Runs in this office’s project folder on the machine hosting Iteration1.</p>
        <label>Cursor task<textarea value={cursorPrompt} onChange={e => setCursorPrompt(e.target.value)} rows={3} maxLength={12000} /></label>
        <label>Cursor model ID<input value={cursorModel} onChange={e => setCursorModel(e.target.value)} maxLength={120} /></label>
        <button className="primary full" disabled={launching || !cursorPrompt.trim() || !cursorModel.trim()} onClick={() => void launchCursor()}><Play size={16} />{launching ? 'Launching…' : 'Launch Cursor agent'}</button>
      </>}
    </details>}
    <details className="compact-disclosure"><summary>Use an existing Cursor session</summary>
    {outcome && <p className="notice">Outcome: {outcome}</p>}<p>Open this folder in Cursor and enable <b>iteration1</b> in MCP settings. Then send the prepared prompt.</p>
    <a className="primary full" href={`cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`}><ArrowUpRight size={16} /> Continue in Cursor</a>
    <button className="text-button" onClick={() => void copy(prompt, 'prompt')}>{copied === 'prompt' ? <Check size={15} /> : <Copy size={15} />} {copied === 'prompt' ? 'Prompt copied' : 'Copy prompt'}</button>
    {room.demo && <p className="notice">The prompt opens a live room; this demo stays separate.</p>}
    <p className="muted small">Manage models and execution in Cursor.</p>
    </details>
    <details className="compact-disclosure"><summary>Cursor connection setup</summary>
      <p>If the connection is missing, merge this entry into <code>.cursor/mcp.json</code>. Keep existing servers.</p>
      {data ? <><button className="secondary full" onClick={() => void copy(config, 'config')}>{copied === 'config' ? <Check size={15} /> : <Copy size={15} />} {copied === 'config' ? 'Copied' : 'Copy configuration'}</button><textarea aria-label="Cursor MCP configuration" className="integration-config" readOnly rows={8} value={config} /></> : <p>{error ? 'Configuration unavailable.' : 'Loading configuration…'}</p>}
      <label>Prompt<textarea readOnly rows={3} value={prompt}/></label>
      <button className="text-button" onClick={() => void load()}>Refresh connection details</button>
    </details>
    </>}
    </section>
    {error && selected !== 'cursor' && <p className="notice error" role="alert">{error}</p>}
    <details className="compact-disclosure office-identity"><summary>Office identity (optional)</summary>
      <p className="muted small">Attribute reported work to an office identity. Provider sign-ins above work independently.</p>
      {auth?.signedIn && auth.identity
        ? <><p className="notice">Signed in as <b>{auth.identity.label}</b>{auth.identity.email ? ` · ${auth.identity.email}` : ''}. Cursor, Claude Code and Codex CLI sessions publish under this account automatically.</p>
            <p className="muted small">{auth.identity.record.started} runs started · {auth.identity.record.verified} verified</p>
            <button className="text-button" onClick={() => void signOut()}>Sign out</button></>
        : auth?.provider
          ? <><p>Sign in once. Cursor, Claude Code and Codex CLI sessions then publish under your account with a durable desk and track record, and nothing secret goes in <code>.cursor/mcp.json</code>.</p>
              <button className="primary full" onClick={() => void signIn()}>Sign in with Auth0</button>
              <p className="muted small">Opens <code>{auth.provider.domain}</code> in a browser tab.</p></>
          : <><p>Connect an Auth0 tenant once to enable sign-in. The domain and client id are public for a PKCE client; no client secret is stored.</p>
              <label>Tenant domain<input value={domain} onChange={e => setDomain(e.target.value)} placeholder="your-tenant.us.auth0.com" /></label>
              <label>Client id<input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Native application client id" /></label>
              <button className="secondary full" disabled={!domain.trim() || !clientId.trim()} onClick={() => void connectProvider()}>Connect Auth0</button>
              {auth && <p className="muted small">Allow this callback URL in the Auth0 application: <code>{auth.redirectUri}</code></p>}</>}
    </details>
  </div>;
}
