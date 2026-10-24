import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { calculateDockPosition, readDockPosition, writeDockPosition } from "./docking.js";

const area = { x: 1920, y: 0, width: 1920, height: 1080 };

test("docks at all four corners and four edges while respecting monitor origin", () => {
  const size = [100, 100] as const;
  assert.deepEqual(calculateDockPosition(area, size, "top-left"), { x: 1936, y: 16 });
  assert.deepEqual(calculateDockPosition(area, size, "top-right"), { x: 3724, y: 16 });
  assert.deepEqual(calculateDockPosition(area, size, "bottom-left"), { x: 1936, y: 964 });
  assert.deepEqual(calculateDockPosition(area, size, "bottom-right"), { x: 3724, y: 964 });
  assert.deepEqual(calculateDockPosition(area, size, "left"), { x: 1936, y: 490 });
  assert.deepEqual(calculateDockPosition(area, size, "right"), { x: 3724, y: 490 });
  assert.deepEqual(calculateDockPosition(area, size, "top"), { x: 2830, y: 16 });
  assert.deepEqual(calculateDockPosition(area, size, "bottom"), { x: 2830, y: 964 });
});

test("clamps oversized windows into the display work area", () => {
  assert.deepEqual(calculateDockPosition({ x: -1280, y: 0, width: 1280, height: 720 }, [2000, 900], "bottom-right"), {
    x: -1280, y: 0,
  });
});

test("persists a valid docking preference and safely defaults for corrupt settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vanessa-dock-"));
  const settings = path.join(root, "settings", "dock.json");
  try {
    assert.equal(readDockPosition(settings), "bottom-right");
    writeDockPosition(settings, "left");
    assert.equal(readDockPosition(settings), "left");
    fs.writeFileSync(settings, "{broken", "utf8");
    assert.equal(readDockPosition(settings), "bottom-right");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
