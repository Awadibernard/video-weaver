/**
 * fitText.ts — Texte adaptatif (responsive text) pour le canvas.
 *
 * Recherche la plus grande taille de police (entre `min` et `max`) permettant
 * au texte de tenir dans une boîte donnée (largeur ET hauteur), en gérant le
 * retour à la ligne automatique. Le texte ne déborde donc jamais de sa zone.
 */

export type FitOptions = {
  maxFontSize: number;
  minFontSize: number;
  lineHeightRatio?: number;
  fontFamily?: string;
  fontWeight?: string;
  maxLines?: number;
};

export function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/**
 * Calcule la taille de police et les lignes qui tiennent dans la boîte.
 */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  boxWidth: number,
  boxHeight: number,
  opts: FitOptions,
): { fontSize: number; lineHeight: number; lines: string[] } {
  const family = opts.fontFamily ?? "Arial, sans-serif";
  const weight = opts.fontWeight ?? "bold";
  const ratio = opts.lineHeightRatio ?? 1.3;

  let best = {
    fontSize: opts.minFontSize,
    lineHeight: opts.minFontSize * ratio,
    lines: [text],
  };

  for (let size = Math.round(opts.maxFontSize); size >= Math.round(opts.minFontSize); size -= 1) {
    ctx.font = `${weight} ${size}px ${family}`;
    const lines = wrapLines(ctx, text, boxWidth);
    const lineHeight = size * ratio;
    const fitsHeight = lines.length * lineHeight <= boxHeight;
    const fitsLines = opts.maxLines ? lines.length <= opts.maxLines : true;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (fitsHeight && fitsLines && widest <= boxWidth) {
      return { fontSize: size, lineHeight, lines };
    }
    best = { fontSize: size, lineHeight, lines };
  }

  // Taille minimale atteinte : on tronque si nécessaire pour ne pas déborder.
  ctx.font = `${weight} ${opts.minFontSize}px ${family}`;
  const lineHeight = opts.minFontSize * ratio;
  let lines = wrapLines(ctx, text, boxWidth);
  const maxLines = Math.max(1, Math.floor(boxHeight / lineHeight));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\s+\S*$/, "")}…`;
  }
  return { fontSize: opts.minFontSize, lineHeight, lines };
}

/**
 * Dessine un texte adaptatif centré verticalement dans sa boîte.
 * (x = centre horizontal si textAlign="center", y = centre vertical)
 */
export function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  boxWidth: number,
  boxHeight: number,
  opts: FitOptions,
): void {
  const family = opts.fontFamily ?? "Arial, sans-serif";
  const weight = opts.fontWeight ?? "bold";
  const { fontSize, lineHeight, lines } = fitText(ctx, text, boxWidth, boxHeight, opts);
  ctx.font = `${weight} ${fontSize}px ${family}`;
  ctx.textBaseline = "middle";
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, startY + i * lineHeight));
}
