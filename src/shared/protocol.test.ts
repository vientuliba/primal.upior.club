import { describe, expect, it } from "vitest";
import { estimateClockOffset, expectedPosition, shouldCorrectDrift, toWidgetVolume } from "./protocol";

describe("synchronization math", () => {
  it("projects a playing anchor and leaves a paused anchor fixed", () => {
    expect(expectedPosition({ currentItemId: "x", playing: true, anchorPosition: 2_000, anchorTimestamp: 10_000 }, 12_500)).toBe(4_500);
    expect(expectedPosition({ currentItemId: "x", playing: false, anchorPosition: 2_000, anchorTimestamp: 10_000 }, 12_500)).toBe(2_000);
  });

  it("uses the lowest-latency clock samples", () => {
    expect(estimateClockOffset([
      { offset: 500, latency: 100 }, { offset: 102, latency: 10 }, { offset: 100, latency: 8 },
      { offset: 98, latency: 9 }, { offset: -500, latency: 200 },
    ])).toBe(100);
  });

  it("corrects only drift greater than one second", () => {
    expect(shouldCorrectDrift(1_000, 2_000)).toBe(false);
    expect(shouldCorrectDrift(999, 2_000)).toBe(true);
  });

  it("uses an audio-taper volume curve with fine quiet-range control", () => {
    expect(toWidgetVolume(0)).toBe(0);
    expect(toWidgetVolume(25)).toBe(4);
    expect(toWidgetVolume(50)).toBe(19);
    expect(toWidgetVolume(100)).toBe(100);
  });
});
