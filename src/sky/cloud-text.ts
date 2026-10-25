// Draws a cloud's title and description, and the agent blobs, onto canvases used as textures,
// so they are part of the sky's drawing and a cloud on top covers them like any other part of
// the cloud underneath. Layout matches the HTML labels (see .vector-sky .sky-label in sky.css).

export interface CloudText { title: string; description: string; mine: boolean; width: number }

const INK = '#26324a';
const PADDING_X = 10, PADDING_Y = 8, GAP = 5;
const titleFont = (mine: boolean) => `600 ${mine ? 21 : 20}px Urbanist, sans-serif`;
const titleSize = (mine: boolean) => mine ? 21 : 20;
const BODY_FONT = '500 12.5px Urbanist, sans-serif', BODY_SIZE = 12.5;

/** Lines of `text` that fit `width`, breaking only between words; past `max` lines, an ellipsis. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number) {
  const words = text.split(/\s+/).filter(Boolean), lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(next).width <= width) { line = next; continue; }
    lines.push(line); line = word;
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1];
  while (last && ctx.measureText(`${last}…`).width > width) last = last.replace(/\s*\S+$/, '');
  kept[max - 1] = `${last}…`;
  return kept;
}

/** Height of a label in its own pixels, title alone or with its description. */
export function labelHeight(text: CloudText, detail: boolean) {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = titleFont(text.mine);
  const title = wrap(ctx, text.title, text.width - PADDING_X * 2, 2).length * titleSize(text.mine) * 1.2;
  if (!detail || !text.description) return PADDING_Y * 2 + title;
  ctx.font = BODY_FONT;
  return PADDING_Y * 2 + title + GAP + wrap(ctx, text.description, text.width - PADDING_X * 2, 2).length * BODY_SIZE * 1.4;
}

/** Draws a label at `resolution` canvas pixels per label pixel. Returns the canvas and its size in label pixels. */
export function drawLabel(text: CloudText, detail: boolean, resolution: number) {
  const height = labelHeight(text, detail), canvas = document.createElement('canvas');
  canvas.width = Math.ceil(text.width * resolution); canvas.height = Math.ceil(height * resolution);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(resolution, resolution);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = INK;
  let y = PADDING_Y;
  ctx.font = titleFont(text.mine);
  for (const line of wrap(ctx, text.title, text.width - PADDING_X * 2, 2)) { ctx.fillText(line, text.width / 2, y + titleSize(text.mine) * .6); y += titleSize(text.mine) * 1.2; }
  if (detail && text.description) {
    y += GAP; ctx.font = BODY_FONT; ctx.globalAlpha = .78;
    for (const line of wrap(ctx, text.description, text.width - PADDING_X * 2, 2)) { ctx.fillText(line, text.width / 2, y + BODY_SIZE * .7); y += BODY_SIZE * 1.4; }
  }
  return { canvas, width: text.width, height };
}

/** An agent blob, as in the office: a round body with eyes, in its type's color. 30 by 31 label pixels. */
export function drawBlob(color: string, resolution: number) {
  const canvas = document.createElement('canvas'), size = 30;
  canvas.width = Math.ceil(size * resolution); canvas.height = Math.ceil(size * 31 / 30 * resolution);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(resolution * size / 42, resolution * size / 42);
  ctx.fillStyle = '#1f284022'; ctx.beginPath(); ctx.ellipse(21, 42, 12, 2.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color; ctx.strokeStyle = '#ffffffd0'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(21, 22, 19, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f8f8ef';
  for (const x of [15.5, 26.5]) { ctx.beginPath(); ctx.ellipse(x, 18, 4.1, 5.1, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#34443b';
  for (const x of [15.9, 26.9]) { ctx.beginPath(); ctx.ellipse(x, 18.8, 1.8, 2.4, 0, 0, Math.PI * 2); ctx.fill(); }
  return canvas;
}
