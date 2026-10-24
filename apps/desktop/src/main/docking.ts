import * as fs from "node:fs";
import * as path from "node:path";

export type DockPosition =
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | "left" | "right" | "top" | "bottom";

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DockCoordinates {
  x: number;
  y: number;
}

/** Calculate dock placement in Electron display coordinates, including multi-monitor origins. */
export function calculateDockPosition(
  workArea: WorkArea,
  windowSize: readonly [number, number],
  position: DockPosition,
  margin = 16,
): DockCoordinates {
  const [rawWidth, rawHeight] = windowSize;
  const width = Math.max(1, Math.min(rawWidth, workArea.width));
  const height = Math.max(1, Math.min(rawHeight, workArea.height));
  const safeMargin = Math.max(0, margin);
  const left = workArea.x + safeMargin;
  const top = workArea.y + safeMargin;
  const right = workArea.x + workArea.width - width - safeMargin;
  const bottom = workArea.y + workArea.height - height - safeMargin;
  const centerX = workArea.x + Math.round((workArea.width - width) / 2);
  const centerY = workArea.y + Math.round((workArea.height - height) / 2);

  let x: number;
  let y: number;
  switch (position) {
    case "top-left": x = left; y = top; break;
    case "top-right": x = right; y = top; break;
    case "bottom-left": x = left; y = bottom; break;
    case "bottom-right": x = right; y = bottom; break;
    case "left": x = left; y = centerY; break;
    case "right": x = right; y = centerY; break;
    case "top": x = centerX; y = top; break;
    case "bottom": x = centerX; y = bottom; break;
    default: x = right; y = bottom;
  }

  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height)),
  };
}

export function isDockPosition(value: unknown): value is DockPosition {
  return value === "top-left" || value === "top-right" ||
    value === "bottom-left" || value === "bottom-right" ||
    value === "left" || value === "right" || value === "top" || value === "bottom";
}

export function readDockPosition(settingsPath: string, fallback: DockPosition = "bottom-right"): DockPosition {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { dockPosition?: unknown };
    return isDockPosition(parsed?.dockPosition) ? parsed.dockPosition : fallback;
  } catch {
    return fallback;
  }
}

export function writeDockPosition(settingsPath: string, dockPosition: DockPosition): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = settingsPath + ".tmp";
  fs.writeFileSync(temporaryPath, JSON.stringify({ dockPosition, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  fs.renameSync(temporaryPath, settingsPath);
}
