import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// The Anthropic API key Claude desks run with. ANTHROPIC_API_KEY in the environment wins;
// otherwise a key pasted in the app is kept in the office's own folder, readable only by
// this user, so it is entered once and survives restarts. It is never sent to the browser.
export const apiKeyField = z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,}$/, 'That does not look like an Anthropic API key. Keys start with sk-ant-.');

export function createClaudeKeyStore({
  file = process.env.OFFICE_CLAUDE_KEY_FILE || path.join(homedir(), '.iteration1', 'anthropic-key.json'),
  env = () => process.env.ANTHROPIC_API_KEY,
  verify = verifyKey
} = {}) {
  let saved = null;
  async function load() {
    try { saved = apiKeyField.parse(JSON.parse(await readFile(file, 'utf8')).apiKey); }
    catch { saved = null; } // Missing or unreadable: the user connects again.
  }
  const current = () => env() || saved || '';
  function status() {
    const key = current();
    return { configured: !!key, source: env() ? 'environment' : saved ? 'saved' : null, hint: key ? `…${key.slice(-4)}` : null };
  }
  /** Checks the key with Anthropic before keeping it, so a typo fails here rather than in a run. */
  async function save(input) {
    if (env()) throw new Error('ANTHROPIC_API_KEY is set in the environment, so it is used instead. Unset it to connect a key here.');
    const key = apiKeyField.parse(input);
    await verify(key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ apiKey: key }), { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {}); // writeFile keeps the mode of an existing file.
    saved = key;
    return status();
  }
  async function remove() {
    await rm(file, { force: true });
    saved = null;
    return status();
  }
  return { load, current, status, save, remove };
}

export async function verifyKey(apiKey) {
  try { await new Anthropic({ apiKey, maxRetries: 1, timeout: 15000 }).models.list({ limit: 1 }); }
  catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new Error('Anthropic did not accept that key. Check that you copied all of it, or create a new one.');
    if (error instanceof Anthropic.PermissionDeniedError) throw new Error('That key cannot use the Claude API. Check the key’s workspace and permissions.');
    if (error instanceof Anthropic.APIConnectionError) throw new Error('Could not reach Anthropic to check the key. Check your internet connection and try again.');
    if (error instanceof Anthropic.APIError) throw new Error(`Anthropic could not check the key right now (${error.status ?? 'error'}). Try again shortly.`);
    throw error;
  }
}
