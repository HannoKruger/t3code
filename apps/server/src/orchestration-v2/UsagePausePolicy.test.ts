import { describe, expect, it } from "vite-plus/test";
import { RunId, ThreadId, type ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  findUsagePauseLimit,
  nextUsagePauseDeadline,
  planUsagePauseAction,
  readUsagePauseMessageId,
  usagePauseMessageId,
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
const THREAD_ID = ThreadId.make("thread-1");
const RUN_ID = RunId.make("run-1");

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
  id: THREAD_ID,
  working: true,
  interruptRunId: RUN_ID,
  latestUserAuthoredMessageAt: at(-minutes(30)),
  limit: sessionLimit,
  limitAlreadyEnforced: false,
  latestPause: null,
  ...overrides,
});

const makePause = (overrides: Partial<UsagePauseRecord> = {}): UsagePauseRecord => ({
  id: "usage-pause:thread-1:five_hour:2026-10-14T12:00:00.000Z",
  createdAt: at(-minutes(1)),
  resetsAt: SESSION_RESET,
  resumeAt: "2026-10-14T12:02:00.000Z",
  resumed: false,
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

  it("ignores model-scoped weekly windows", () => {
    const modelWindow = { ...weeklyWindow(100), id: "seven_day_opus", label: "Weekly · Opus" };
    expect(findUsagePauseLimit([modelWindow], THRESHOLDS, NOW_MS)).toBeNull();
  });
});

describe("usage pause message ids", () => {
  it("round-trips the thread, window and reset that identify one pause", () => {
    const id = usagePauseMessageId(THREAD_ID, sessionLimit);
    expect(id).toBe("usage-pause:thread-1:five_hour:2026-10-14T12:00:00.000Z");
    expect(readUsagePauseMessageId(THREAD_ID, id)).toEqual({
      windowId: "five_hour",
      resetsAt: SESSION_RESET,
      resumeAt: "2026-10-14T12:02:00.000Z",
    });
    expect(readUsagePauseMessageId(THREAD_ID, "message-1")).toBeNull();
  });

  it("reads the pause of a thread whose id contains colons", () => {
    const threadId = ThreadId.make("thread:scheduled:1");
    expect(readUsagePauseMessageId(threadId, usagePauseMessageId(threadId, sessionLimit))).toEqual({
      windowId: "five_hour",
      resetsAt: SESSION_RESET,
      resumeAt: "2026-10-14T12:02:00.000Z",
    });
  });
});

describe("planUsagePauseAction", () => {
  it("asks a working thread to stop and schedules its resume after the reset", () => {
    expect(planUsagePauseAction(makeThread(), NOW_MS)).toEqual({
      type: "pause",
      threadId: THREAD_ID,
      limit: sessionLimit,
      resumeAt: "2026-10-14T12:02:00.000Z",
    });
  });

  it("leaves idle threads alone, since they are not spending usage", () => {
    expect(planUsagePauseAction(makeThread({ working: false }), NOW_MS)).toBeNull();
  });

  it("leaves a thread started after the limit was enforced running", () => {
    expect(planUsagePauseAction(makeThread({ limitAlreadyEnforced: true }), NOW_MS)).toBeNull();
  });

  it("does not pause twice for the same window after the user took over", () => {
    const thread = makeThread({
      latestPause: makePause({ createdAt: at(-minutes(10)) }),
      latestUserAuthoredMessageAt: at(-minutes(5)),
    });
    expect(planUsagePauseAction(thread, NOW_MS)).toBeNull();
  });

  it("gives a paused thread a grace period to wrap up before stopping it", () => {
    const thread = makeThread({ latestPause: makePause({ createdAt: at(-minutes(4)) }) });
    expect(planUsagePauseAction(thread, NOW_MS)).toBeNull();
  });

  it("stops the run of a paused thread that still works after the grace period", () => {
    const pause = makePause({ createdAt: at(-minutes(5)) });
    expect(planUsagePauseAction(makeThread({ latestPause: pause }), NOW_MS)).toEqual({
      type: "interrupt",
      threadId: THREAD_ID,
      pauseId: pause.id,
      runId: RUN_ID,
    });
  });

  it("waits until the resume time", () => {
    const thread = makeThread({ working: false, limit: null, latestPause: makePause() });
    expect(planUsagePauseAction(thread, NOW_MS)).toBeNull();
  });

  it("resumes a paused thread once its resume time has passed", () => {
    const pause = makePause({ resumeAt: at(-1) });
    const thread = makeThread({ working: false, limit: null, latestPause: pause });
    expect(planUsagePauseAction(thread, NOW_MS)).toEqual({
      type: "resume",
      threadId: THREAD_ID,
      pauseId: pause.id,
    });
  });

  it("keeps waiting while another window is still over its limit", () => {
    const weeklyLimit = { ...sessionLimit, windowId: "seven_day", resetsAt: WEEKLY_RESET };
    const thread = makeThread({
      working: false,
      limit: weeklyLimit,
      latestPause: makePause({ resumeAt: at(-1) }),
    });
    expect(planUsagePauseAction(thread, NOW_MS)).toBeNull();
  });

  it("does nothing once the thread was resumed or the user wrote to it", () => {
    const resumed = makePause({ resumeAt: at(-1), resumed: true });
    expect(
      planUsagePauseAction(
        makeThread({ working: false, limit: null, latestPause: resumed }),
        NOW_MS,
      ),
    ).toBeNull();
    const takenOver = makePause({ resumeAt: at(-1), createdAt: at(-minutes(60)) });
    expect(
      planUsagePauseAction(
        makeThread({
          working: false,
          limit: null,
          latestPause: takenOver,
          latestUserAuthoredMessageAt: at(-minutes(30)),
        }),
        NOW_MS,
      ),
    ).toBeNull();
  });
});

describe("nextUsagePauseDeadline", () => {
  it("wakes at the end of the grace period for a paused thread that still works", () => {
    const pause = makePause({ createdAt: at(-minutes(1)) });
    expect(nextUsagePauseDeadline(makeThread({ latestPause: pause }))).toBe(NOW_MS + minutes(4));
  });

  it("wakes at the resume time for a paused thread that has stopped", () => {
    const pause = makePause();
    expect(nextUsagePauseDeadline(makeThread({ working: false, latestPause: pause }))).toBe(
      Date.parse(pause.resumeAt),
    );
  });

  it("wakes after the later reset when another window keeps the thread paused", () => {
    const weeklyLimit = { ...sessionLimit, windowId: "seven_day", resetsAt: WEEKLY_RESET };
    expect(
      nextUsagePauseDeadline(
        makeThread({
          working: false,
          limit: weeklyLimit,
          latestPause: makePause({ resumeAt: at(-1) }),
        }),
      ),
    ).toBe(Date.parse("2026-10-17T08:02:00.000Z"));
  });

  it("has nothing to wake for when no pause is open", () => {
    expect(nextUsagePauseDeadline(makeThread())).toBeNull();
    expect(
      nextUsagePauseDeadline(makeThread({ latestPause: makePause({ resumed: true }) })),
    ).toBeNull();
  });
});
