import path from 'node:path';

// Exercise the same native sandbox used by workers before spending a model turn.
export async function checkWorkspace(codex, folder, platform = process.platform) {
  const command = platform === 'win32'
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; (Get-Location).Path; Get-ChildItem -LiteralPath . -Name | Select-Object -First 1']
    : ['/bin/sh', '-c', 'pwd; ls -d .'];
  const result = await codex.call('command/exec', { command, cwd: folder, sandboxPolicy: { type: 'readOnly' }, timeoutMs: 10000 });
  const actual = (result.stdout || '').trim().split(/\r?\n/)[0];
  const paths = platform === 'win32' ? path.win32 : path;
  const same = actual && (platform === 'win32' ? paths.resolve(actual).toLowerCase() === paths.resolve(folder).toLowerCase() : paths.resolve(actual) === paths.resolve(folder));
  if (result.exitCode !== 0 || !same) throw new Error('Codex cannot read this project folder in its sandbox. Check folder access in Settings, or use a local project folder outside a protected sync directory, then retry. No model work was started.');
  return { checkedAt: Date.now(), path: folder, readable: true };
}
