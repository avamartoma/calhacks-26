import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeCode } from '../convex/lib/claudeCode.ts';

test('the code claude.ai shows, or its callback address, is accepted for this sign-in only', () => {
  assert.equal(parseClaudeCode('abc123#state-1', 'state-1'), 'abc123');
  assert.equal(parseClaudeCode(' https://platform.claude.com/oauth/code/callback?code=xyz&state=state-1 ', 'state-1'), 'xyz');
  assert.throws(() => parseClaudeCode('abc123#other', 'state-1'), /different sign-in/);
  assert.throws(() => parseClaudeCode('https://evil.example/oauth/code/callback?code=x&state=state-1', 'state-1'), /isn't from this Claude sign-in/);
  assert.throws(() => parseClaudeCode('abc123', 'state-1'), /Paste the code/);
  assert.throws(() => parseClaudeCode('https://platform.claude.com/oauth/code/callback?error=access_denied&state=state-1', 'state-1'), /declined/);
});
