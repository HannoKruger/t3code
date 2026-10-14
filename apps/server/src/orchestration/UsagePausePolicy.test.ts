import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnId, type ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  findUsagePauseLimit,
  isNearUsagePauseLimit,
  planUsagePauseAction,
  type UsagePauseLimit,
  type UsagePauseRecord,
  type UsagePauseThread,
} from "./UsagePausePolicy.ts";

const NOW = "2026-10-14T10:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const SESSION_RESET = "2026-10-14T12:00:00.000Z";
const WEEKLY_RESET = "2026-10-17T08:00:00.000Z";
const THRESHOLDS = { sessionPercent: 90, weeklyPercent: 98 };
const minutes = (count: number) => count * 60 * 1_000;
const at = (offsetMs: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW_MS + offsetMs));

const sessionWindow = (
  usedPercent: number,
  resetsAt = SESSION_RESET,
): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt,
});
const weeklyWindow = (usedPercent: number, resetsAt = WEEKLY_RESET): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt,
});

const sessionLimit: UsagePauseLimit = {
  windowId: "five_hour",
  label: "Session",
  usedPercent: 91,
  resetsAt: SESSION_RESET,
};

const makeThread = (overrides: Partial<UsagePauseThread> = {}): UsagePauseThread => ({
  id: ThreadId.make("thread-1"),
  running: true,
  activeTurnId: TurnId.make("turn-1"),
  latestUserMessageAt: at(-minutes(30)),
  limit: sessionLimit,
  limitAlreadyEnforced: false,
  latestPause: null,
  ...overrides,
});

const makePause = (overrides: Partial<UsagePauseRecord> = {}): UsagePauseRecord => ({
  id: "usage-pause:thread-1:2026-10-14T12:00:00.000Z",
  createdAt: at(-minutes(1)),
  resetsAt: SESSION_RESET,
  resumeAt: "2026-10-14T12:02:00.000Z",
  ...overrides,
});

describe("findUsagePauseLimit", () => {
  it("pauses the session window at its threshold", () => {
    expect(findUsagePauseLimit([sessionWindow(90)], THRESHOLDS, NOW_MS)).toEqual({
      windowId: "five_hour",
      label: "Session",
      usedPercent: 90,
      resetsAt: SESSION_RESET,
    });
    expect(findUsagePauseLimit([sessionWindow(89.9)], THRESHOLDS, NOW_MS)).toBeNull();
  });

  it("holds the weekly window to its own, higher threshold", () => {
    expect(findUsagePauseLimit([weeklyWindow(97)], THRESHOLDS, NOW_MS)).toBeNull();
    expect(findUsagePauseLimit([weeklyWindow(98)], THRESHOLDS, NOW_MS)?.windowId).toBe("seven_day");
  });

  it("waits for the window that resets last when both are over", () => {
    expect(
      findUsagePauseLimit([sessionWindow(95), weeklyWindow(99)], THRESHOLDS, NOW_MS)?.resetsAt,
    ).toBe(WEEKLY_RESET);
  });

  it("ignores windows whose reset has passed, because their percentage is stale", () => {
    expect(findUsagePauseLimit([sessionWindow(100, at(-1))], THRESHOLDS, NOW_MS)).toBeNull();
  });

  it("ignores windows without a reset time, because nothing could resume them", () => {
    const { resetsAt: _resetsAt, ...withoutReset } = sessionWindow(100);
    expect(findUsagePauseLimit([withoutReset], THRESHOLDS, NOW_MS)).toBeNull();
  });

  it("ignores model-scoped weekly windows", () => {
    const modelWindow = { ...weeklyWindow(100), id: "seven_day_opus", label: "Weekly · Opus" };
    expect(findUsagePauseLimit([modelWindow], THRESHOLDS, NOW_MS)).toBeNull();
  });
});

describe("isNearUsagePauseLimit", () => {
  it("is near within ten points of a threshold", () => {
    expect(isNearUsagePauseLimit([sessionWindow(80)], THRESHOLDS, NOW_MS)).toBe(true);
    expect(isNearUsagePauseLimit([sessionWindow(79)], THRESHOLDS, NOW_MS)).toBe(false);
    expect(isNearUsagePauseLimit([weeklyWindow(88)], THRESHOLDS, NOW_MS)).toBe(true);
  });
});

describe("planUsagePauseAction", () => {
  it("asks a running thread to stop and schedules its resume after the reset", () => {
    expect(planUsagePauseAction(makeThread(), NOW_MS)).toEqual({
      type: "pause",
      threadId: "thread-1",
      limit: sessionLimit,
      resumeAt: "2026-10-14T12:02:00.000Z",
      steer: true,
    });
  });

  it("leaves a thread started after the limit was enforced running", () => {
    expect(planUsagePauseAction(makeThread({ limitAlreadyEnforced: true }), NOW_MS)).toBeNull();
  });

  it("leaves idle threads alone, since they are not spending usage", () => {
    expect(planUsagePauseAction(makeThread({ running: false }), NOW_MS)).toBeNull();
  });

  it("does not pause twice for the same window after the user took over", () => {
    const thread = makeThread({
      latestPause: makePause({ createdAt: at(-minutes(10)) }),
      latestUserMessageAt: at(-minutes(5)),
    });
    expect(planUsagePauseAction(thread, NOW_MS)).toBeNull();
  });

  it("gives a paused thread a grace period to wrap up before stopping it", () => {
    const pause = makePause({ createdAt: at(-minutes(2)) });
    const thread = makeThread({ latestPause: pause, latestUserMessageAt: pause.createdAt });
    expect(planUsagePauseAction(thread, NOW_MS)).toBeNull();
  });

  it("stops a paused thread that is still running after the grace period", () => {
    const pause = makePause({ createdAt: at(-minutes(3)) });
    const thread = makeThread({ latestPause: pause, latestUserMessageAt: pause.createdAt });
    expect(planUsagePauseAction(thread, NOW_MS)).toEqual({
      type: "interrupt",
      threadId: "thread-1",
      pauseId: pause.id,
      turnId: "turn-1",
    });
  });

  it("waits until the resume time", () => {
    const thread = makeThread({ running: false, limit: null, latestPause: makePause() });
    expect(planUsagePauseAction(thread, NOW_MS)).toBeNull();
  });

  it("resumes a paused thread once its resume time has passed", () => {
    const pause = makePause({ resumeAt: at(-1) });
    const thread = makeThread({ running: false, limit: null, latestPause: pause });
    expect(planUsagePauseAction(thread, NOW_MS)).toEqual({
      type: "resume",
      threadId: "thread-1",
      pauseId: pause.id,
    });
  });

  it("does not resume a thread the user has written to since the pause", () => {
    const pause = makePause({ resumeAt: at(-1), createdAt: at(-minutes(60)) });
    const thread = makeThread({
      running: false,
      limit: null,
      latestPause: pause,
      latestUserMessageAt: at(-minutes(30)),
    });
    expect(planUsagePauseAction(thread, NOW_MS)).toBeNull();
  });

  it("moves the resume time when another window is over the limit at resume time", () => {
    const weeklyLimit: UsagePauseLimit = {
      windowId: "seven_day",
      label: "Weekly",
      usedPercent: 99,
      resetsAt: WEEKLY_RESET,
    };
    const thread = makeThread({
      running: false,
      limit: weeklyLimit,
      latestPause: makePause({ resumeAt: at(-1) }),
    });
    expect(planUsagePauseAction(thread, NOW_MS)).toEqual({
      type: "pause",
      threadId: "thread-1",
      limit: weeklyLimit,
      resumeAt: "2026-10-17T08:02:00.000Z",
      steer: false,
    });
  });
});
