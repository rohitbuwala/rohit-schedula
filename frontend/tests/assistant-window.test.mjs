import assert from "node:assert/strict";
import { it } from "node:test";
import { fitAssistantBounds, updateAssistantBounds } from "../components/assistant/use-assistant-window.ts";

const viewport = { width: 1280, height: 900 };
const bounds = { left: 840, top: 476, width: 416, height: 400 };

it("clamps dragging at each viewport edge", () => {
  assert.deepEqual(updateAssistantBounds(bounds, viewport, "move", -2000, -2000), {
    ...bounds, left: 16, top: 16,
  });
  assert.deepEqual(updateAssistantBounds(bounds, viewport, "move", 2000, 2000), {
    ...bounds, left: 848, top: 484,
  });
});

it("resizes from the top-left and keeps the opposite corner fixed", () => {
  assert.deepEqual(updateAssistantBounds(bounds, viewport, "resize", -120, -100), {
    left: 720, top: 376, width: 536, height: 500,
  });
  assert.deepEqual(updateAssistantBounds(bounds, viewport, "resize", -2000, -2000), {
    left: 536, top: 116, width: 720, height: 760,
  });
  assert.deepEqual(updateAssistantBounds(bounds, viewport, "resize", 2000, 2000), {
    left: 936, top: 626, width: 320, height: 250,
  });
});

it("keeps a customized panel visible after the viewport shrinks", () => {
  assert.deepEqual(fitAssistantBounds({ left: 536, top: 116, width: 720, height: 760 }, { width: 800, height: 240 }), {
    left: 64, top: 16, width: 720, height: 208,
  });
});
