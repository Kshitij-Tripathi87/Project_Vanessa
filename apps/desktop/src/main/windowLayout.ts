export type DockCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface WorkAreaBounds { x: number; y: number; width: number; height: number }
export interface WindowDimensions { width: number; height: number }

/** Places a floating window against a display work-area corner, including
 * non-zero work-area origins and taskbar offsets. */
export function calculateDockPosition(
  workArea: WorkAreaBounds,
  windowSize: WindowDimensions,
  corner: DockCorner,
  margin = 24,
): { x: number; y: number } {
  const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 24;
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = Math.max(minX, workArea.x + workArea.width - Math.max(1, windowSize.width));
  const maxY = Math.max(minY, workArea.y + workArea.height - Math.max(1, windowSize.height));
  const leftX = Math.min(minX + safeMargin, maxX);
  const topY = Math.min(minY + safeMargin, maxY);
  const rightX = Math.max(minX, maxX - safeMargin);
  const bottomY = Math.max(minY, maxY - safeMargin);

  switch (corner) {
    case "top-left": return { x: leftX, y: topY };
    case "top-right": return { x: rightX, y: topY };
    case "bottom-left": return { x: leftX, y: bottomY };
    case "bottom-right":
    default: return { x: rightX, y: bottomY };
  }
}
