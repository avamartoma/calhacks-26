export function workspacePath(input: string, workspaceDir: string, opts?: { allowRoot?: boolean }): string {
  if (input.includes("\0") || input.trim().length === 0 || workspaceDir.includes("\0") || !workspaceDir.startsWith("/")) {
    throw new Error("invalid path");
  }
  const root = workspaceDir.replace(/\/+$/, "");
  const raw = input.startsWith("/") ? input : `${root}/${input}`;
  const stack: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  const resolved = `/${stack.join("/")}`;
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error("path escapes the repo directory");
  }
  if (!opts?.allowRoot && resolved === root) {
    throw new Error("path must be a file inside the repo directory");
  }
  return resolved;
}
