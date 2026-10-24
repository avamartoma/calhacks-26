import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

export class Codex extends EventEmitter {
  constructor() { super(); this.pending = new Map(); this.seq = 0; this.ready = null; this.process = null; }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch(e => { this.ready = null; throw e; });
    return this.ready;
  }
  async start() {
    // Separate auth store: signing into Fourteenth never switches the desktop/CLI account.
    const codexHome = process.env.OFFICE_CODEX_HOME || path.join(homedir(), '.fourteenth', 'codex');
    mkdirSync(codexHome, { recursive: true });
    const localCli = fileURLToPath(new URL('../.office/runtime/node_modules/@openai/codex/bin/codex.js', import.meta.url));
    const globalCli = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const npmCli = existsSync(localCli) ? localCli : globalCli;
    const command = process.env.OFFICE_CODEX_BIN || ((existsSync(localCli) || process.platform === 'win32' && existsSync(npmCli)) ? process.execPath : 'codex');
    const args = process.env.OFFICE_CODEX_ARGS ? JSON.parse(process.env.OFFICE_CODEX_ARGS) : command === process.execPath ? [npmCli, 'app-server', '--stdio'] : ['app-server', '--stdio'];
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome } });
    this.process = child;
    child.on('error', error => this.fail(error));
    child.on('exit', () => this.fail(new Error('Codex connection closed. Reconnect to continue.')));
    child.stderr.on('data', () => {}); // Do not expose auth or raw diagnostic payloads.
    createInterface({ input: child.stdout }).on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id) && !msg.method) {
        const p = this.pending.get(msg.id); clearTimeout(p.timer); this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) this.emit(msg.id != null ? 'request' : 'notification', msg);
    });
    await this.call('initialize', { clientInfo: { name: 'fourteenth_office', title: 'Fourteenth', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized', {});
  }
  fail(error) { this.ready = null; this.process = null; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); this.emit('offline', error.message); }
  call(method, params = {}) {
    if (!this.process?.stdin.writable) return Promise.reject(new Error('Codex is not connected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex timed out during ${method}`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method, params) { this.process?.stdin.write(JSON.stringify({ method, params }) + '\n'); }
  respond(id, result) { this.process?.stdin.write(JSON.stringify({ id, result }) + '\n'); }
  reject(id, message) { this.process?.stdin.write(JSON.stringify({ id, error: { code: -32601, message } }) + '\n'); }
  async restart() {
    const child=this.process;
    if(child)await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Codex is still closing. Restart the Fourteenth companion to finish sandbox setup.')),10000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});
      child.stdin.end(); // EOF closes the native server behind the npm launcher too.
    });
    await this.connect();
  }
  close() { this.process?.stdin.end(); }
}
