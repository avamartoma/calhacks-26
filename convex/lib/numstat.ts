/** Parses `git diff --numstat` lines into files with added and removed line counts. Binary files show "-" for both. */
export function numstat(text: string): { path: string; added: number; removed: number }[] {
  return text.split("\n").flatMap((line) => {
    const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!match) return [];
    return [{ path: match[3], added: match[1] === "-" ? 0 : Number(match[1]), removed: match[2] === "-" ? 0 : Number(match[2]) }];
  });
}
