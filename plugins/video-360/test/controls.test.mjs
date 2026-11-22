import assert from "node:assert/strict";
import test from "node:test";
import { controlsShown, formatClock } from "../src/controls.ts";

test("the time reads minutes and seconds, with hours only for a video of an hour or more", () => {
  assert.equal(formatClock(12, false), "0:12");
  assert.equal(formatClock(413.7, false), "6:53");
  assert.equal(formatClock(3723, true), "1:02:03");
  assert.equal(formatClock(59.9, true), "0:00:59");
});

test("a time that is not a time reads as zero", () => {
  assert.equal(formatClock(-3, false), "0:00");
  assert.equal(formatClock(Number.NaN, false), "0:00");
  assert.equal(formatClock(Number.POSITIVE_INFINITY, false), "0:00");
});

test("the controls stay up while paused, and fade once the video plays and the pointer rests", () => {
  assert.equal(controlsShown({ playing: false, active: false, dragging: false }), true);
  assert.equal(controlsShown({ playing: true, active: false, dragging: false }), false);
  assert.equal(controlsShown({ playing: true, active: true, dragging: false }), true);
  assert.equal(controlsShown({ playing: true, active: false, dragging: true }), true);
});
