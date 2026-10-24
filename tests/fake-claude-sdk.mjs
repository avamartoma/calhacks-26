// Deterministic stand-in for @anthropic-ai/claude-agent-sdk, loaded through OFFICE_CLAUDE_SDK.
// It reads the prompt stream like Claude Code and calls the office's MCP tool handlers for real,
// so the office code under test is exercised end to end without a model.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export function tool(name, description, shape, handler) { return { name, description, shape, handler }; }
export function createSdkMcpServer({ name, tools }) { return { type: 'sdk', name, instance: { tools } }; }

let sessions = 0;
export function query({ prompt, options }) {
  const session = `fake-session-${++sessions}`;
  const office = options.mcpServers?.office?.instance.tools || [];
  const call = async (name, args) => {
    const found = office.find(t => t.name === name);
    if (!found) return { isError: true, content: [{ type: 'text', text: `${name} unavailable` }] };
    return found.handler(args, {});
  };
  const say = text => ({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const use = (id, name, input) => ({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id, text, isError = false) => ({ type: 'user', session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
  const done = text => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, total_cost_usd: 0.01, num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 } });

  async function* run() {
    yield { type: 'system', subtype: 'init', session_id: session };
    for await (const user of prompt) {
      const text = String(user.message.content);
      // Report what this desk may do, so tests can check permissions.
      yield say(`tools: ${options.tools.join(',')} | office: ${office.map(t => t.name).join(',')} | resume: ${options.resume || 'none'}`);
      if (office.some(t => t.name === 'office_delegate')) {
        yield use('plan', 'TodoWrite', { todos: [{ content: 'Delegate research', status: 'completed' }, { content: 'Implement', status: 'in_progress' }] });
        yield result('plan', 'ok');
        if (!/Worker handoffs/.test(text) && options.tools.includes('Write')) {
          const delegated = await call('office_delegate', { name: 'Scout', role: 'Research', task: 'Find where search lives' });
          yield say(`delegated: ${delegated.content[0].text}`);
          await writeFile(path.join(options.cwd, 'feature.txt'), 'implemented\n');
          yield use('edit', 'Write', { file_path: 'feature.txt', content: 'implemented\n' });
          yield result('edit', 'File written');
          yield use('check', 'Bash', { command: 'npm test' });
          yield result('check', '1 passing');
        }
      } else {
        const status = await call('office_status', {});
        yield say(`worker saw ${JSON.parse(status.content[0].text).workItems.length} work items`);
      }
      yield done('Turn complete');
    }
  }
  return run();
}
