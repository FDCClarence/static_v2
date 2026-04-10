/** Grid state, movement, collision */

/**
 * Parse grid cell label to zero-based indices (x right, y down).
 * Supports chess-style labels (e.g. A1, B2) matching DevOverlay column letter + 1-based row,
 * or "x, y" integer pairs.
 * @param {string} cell
 * @returns {{ x: number; y: number }}
 */
export function parseCell(cell) {
  const s = String(cell).trim();
  const chess = /^([A-Za-z])(\d+)$/.exec(s);
  if (chess) {
    const x = chess[1].toUpperCase().charCodeAt(0) - 65;
    const y = parseInt(chess[2], 10) - 1;
    return { x, y };
  }
  const csv = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(s);
  if (csv) {
    return { x: parseInt(csv[1], 10), y: parseInt(csv[2], 10) };
  }
  throw new Error(`parseCell: invalid cell "${cell}"`);
}

/**
 * Zero-based grid indices → chess-style cell label (column A–Z, 1-based row).
 * @param {number} x
 * @param {number} y
 */
export function formatCell(x, y) {
  const col = Math.max(0, Math.min(25, x));
  return `${String.fromCharCode(65 + col)}${y + 1}`;
}
