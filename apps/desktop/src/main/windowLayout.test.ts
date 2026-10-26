import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateDockPosition } from "./windowLayout.js";

test("anchors the expanded panel within a secondary display's work area", () => {
  const area = { x: 1920, y: 40, width: 2560, height: 1440 };
  const panel = { width: 360, height: 440 };
  assert.deepEqual(calculateDockPosition(area, panel, "top-left"), { x: 1944, y: 64 });
  assert.deepEqual(calculateDockPosition(area, panel, "top-right"), { x: 4096, y: 64 });
  assert.deepEqual(calculateDockPosition(area, panel, "bottom-left"), { x: 1944, y: 1016 });
  assert.deepEqual(calculateDockPosition(area, panel, "bottom-right"), { x: 4096, y: 1016 });
});

test("keeps the 90px orb within bottom-right work-area margins", () => {
  assert.deepEqual(
    calculateDockPosition({ x: 0, y: 0, width: 1920, height: 1080 }, { width: 90, height: 90 }, "bottom-right"),
    { x: 1806, y: 966 },
  );
});

test("clamps oversized windows to the work area's origin", () => {
  assert.deepEqual(
    calculateDockPosition({ x: -1280, y: 120, width: 320, height: 260 }, { width: 360, height: 440 }, "bottom-right"),
    { x: -1280, y: 120 },
  );
});
