import test from 'node:test';
import assert from 'node:assert/strict';
import { inviteMessage } from '../convex/lib/inviteMessage.ts';

test('an invite email names who shared what, links to the project and escapes names', () => {
  const message = inviteMessage({ inviter: 'Ava <script>', project: 'Notes & "API"', projectId: 'k57abc', email: 'davina@example.com', role: 'editor' });
  assert.equal(message.subject, 'Ava <script> shared "Notes & "API"" with you on opencloud');
  assert.equal(message.link, 'https://calhacks-26.vercel.app/project/k57abc');
  assert.match(message.text, /start agents on it/);
  assert.match(message.text, /davina@example\.com/);
  assert.ok(message.html.includes('Ava &lt;script&gt;'));
  assert.ok(message.html.includes('Notes &amp; &quot;API&quot;'));
  assert.ok(!message.html.includes('<script>'));
  assert.match(inviteMessage({ inviter: 'Ava', project: 'P', projectId: 'x', email: 'a@b.co', role: 'viewer' }).text, /watch its agents/);
});
