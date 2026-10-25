// Packs a folder picked in the browser into a .tar.gz, the format a project's sandbox restores
// from. Dependencies, build output and version control are left out; the sandbox reinstalls them.

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo', '.cache', '.venv', 'venv', '__pycache__', '.office', '.vercel', 'coverage', 'target']);
const MAX_FILE_BYTES = 5_000_000;

export interface PackedFolder { name: string; archive: Blob; files: number; bytes: number; skipped: number }

/** The folder's own name and each file's path inside it. */
function inside(file: File) {
  const parts = (file.webkitRelativePath || file.name).split('/');
  return { folder: parts.length > 1 ? parts[0] : '', path: (parts.length > 1 ? parts.slice(1) : parts).join('/') };
}

export function keep(path: string, size: number) {
  const parts = path.split('/');
  if (parts.slice(0, -1).some(part => SKIPPED_DIRS.has(part))) return false;
  if (parts.at(-1) === '.DS_Store') return false;
  return size <= MAX_FILE_BYTES;
}

const encoder = new TextEncoder();

function field(header: Uint8Array, offset: number, length: number, value: string) {
  header.set(encoder.encode(value).subarray(0, length), offset);
}
const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';

/** A ustar header. Paths over 100 bytes are split into prefix and name at a slash. */
export function tarHeader(path: string, size: number, mtime: number) {
  const header = new Uint8Array(512);
  let name = path, prefix = '';
  if (encoder.encode(path).length > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut <= 0 || encoder.encode(path.slice(cut + 1)).length > 100) throw new Error(`The path ${path} is too long to upload`);
    prefix = path.slice(0, cut); name = path.slice(cut + 1);
  }
  field(header, 0, 100, name);
  field(header, 100, 8, octal(0o644, 8));
  field(header, 108, 8, octal(0, 8));
  field(header, 116, 8, octal(0, 8));
  field(header, 124, 12, octal(size, 12));
  field(header, 136, 12, octal(Math.floor(mtime / 1000), 12));
  header.fill(32, 148, 156);
  field(header, 156, 1, '0');
  field(header, 257, 6, 'ustar\0');
  field(header, 263, 2, '00');
  field(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  field(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

export async function packFolder(list: FileList | File[]): Promise<PackedFolder> {
  const all = Array.from(list);
  const chosen = all.map(file => ({ file, ...inside(file) })).filter(entry => keep(entry.path, entry.file.size));
  if (!chosen.length) throw new Error('That folder has no files to upload');
  const parts: BlobPart[] = [];
  let bytes = 0;
  for (const { file, path } of chosen) {
    parts.push(tarHeader(path, file.size, file.lastModified || Date.now()));
    parts.push(file);
    const pad = (512 - (file.size % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
    bytes += file.size;
  }
  parts.push(new Uint8Array(1024));
  const archive = await new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return { name: chosen[0].folder || 'project', archive, files: chosen.length, bytes, skipped: all.length - chosen.length };
}
