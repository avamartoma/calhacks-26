"use node";

declare const process: { env: Record<string, string | undefined> };

type Spawned = {
  kill: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

type ShotModules = {
  spawn: (command: string, args: string[], opts: { stdio: "ignore"; windowsHide: boolean }) => Spawned;
  mkdtemp: (prefix: string) => Promise<string>;
  readFile: (file: string) => Promise<Uint8Array>;
  rm: (file: string, opts: { recursive: boolean; force: boolean }) => Promise<void>;
  access: (file: string) => Promise<void>;
  tmpdir: () => string;
  join: (...parts: string[]) => string;
};

const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;

async function modules(): Promise<ShotModules> {
  const [child, fs, os, path] = await Promise.all([
    load("node:child_process"),
    load("node:fs/promises"),
    load("node:os"),
    load("node:path"),
  ]);
  return {
    spawn: child.spawn as ShotModules["spawn"],
    mkdtemp: fs.mkdtemp as ShotModules["mkdtemp"],
    readFile: fs.readFile as ShotModules["readFile"],
    rm: fs.rm as ShotModules["rm"],
    access: fs.access as ShotModules["access"],
    tmpdir: os.tmpdir as ShotModules["tmpdir"],
    join: path.join as ShotModules["join"],
  };
}

export async function capturePreview(url: string): Promise<Uint8Array | null> {
  if (!/^https:\/\//.test(url)) return null;
  const node = await modules();
  const browser = await findBrowser(node);
  if (!browser) return null;
  const dir = await node.mkdtemp(node.join(node.tmpdir(), "iteration1-shot-"));
  const file = node.join(dir, "preview.png");
  try {
    const code = await new Promise<number>((resolve) => {
      const child = node.spawn(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1280,800", `--screenshot=${file}`, url], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill();
        resolve(1);
      }, 20_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(1);
      });
      child.on("exit", (status) => {
        clearTimeout(timer);
        resolve(typeof status === "number" ? status : 1);
      });
    });
    if (code !== 0) return null;
    const bytes = new Uint8Array(await node.readFile(file));
    return bytes.byteLength > 0 ? bytes : null;
  } catch {
    return null;
  } finally {
    await node.rm(dir, { recursive: true, force: true });
  }
}

async function findBrowser(node: ShotModules): Promise<string | null> {
  const env = process.env;
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || "";
  const candidates = [
    node.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    node.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    node.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    node.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    node.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  for (const candidate of candidates) {
    try {
      await node.access(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  return null;
}
