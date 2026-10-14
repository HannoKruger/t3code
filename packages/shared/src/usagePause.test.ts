import { describe, expect, it } from "vite-plus/test";

import {
  USAGE_PAUSE_ACTIVITY_KIND,
  describeUsagePause,
  formatUsagePauseTime,
  readUsagePausePayload,
  usagePauseActivityLabel,
} from "./usagePause.ts";

const payload = {
  windowId: "five_hour",
  label: "Session",
  usedPercent: 90.4,
  resetsAt: "2026-10-14T12:00:00.000Z",
  resumeAt: "2026-10-14T12:02:00.000Z",
};

describe("readUsagePausePayload", () => {
  it("reads a stored pause", () => {
    expect(readUsagePausePayload(payload)).toEqual(payload);
  });

  it("rejects payloads from other activities", () => {
    expect(readUsagePausePayload({ message: "hello" })).toBeNull();
    expect(readUsagePausePayload(null)).toBeNull();
  });
});

describe("describeUsagePause", () => {
  it("names the window and when work resumes", () => {
    expect(describeUsagePause(payload, () => "12:02")).toBe(
      "Paused: Claude 5-hour usage is at 90%. Resumes automatically 12:02.",
    );
  });

  it("names the weekly window", () => {
    expect(
      describeUsagePause({ ...payload, windowId: "seven_day", label: "Weekly" }, () => "x"),
    ).toBe("Paused: Claude weekly usage is at 90%. Resumes automatically x.");
  });
});

describe("formatUsagePauseTime", () => {
  it("formats the resume time in the requested zone", () => {
    expect(formatUsagePauseTime("2026-10-14T12:02:00.000Z", "Africa/Johannesburg")).toBe(
      "Wed, Oct 14, 2:02 PM GMT+2",
    );
    expect(formatUsagePauseTime("2026-10-14T12:02:00.000Z", "UTC")).toBe(
      "Wed, Oct 14, 12:02 PM UTC",
    );
  });
});

describe("usagePauseActivityLabel", () => {
  it("relabels a pause in the viewer's time zone", () => {
    expect(usagePauseActivityLabel(USAGE_PAUSE_ACTIVITY_KIND, payload)).toBe(
      `Paused: Claude 5-hour usage is at 90%. Resumes automatically ${formatUsagePauseTime(payload.resumeAt)}.`,
    );
  });

  it("leaves other activities alone", () => {
    expect(usagePauseActivityLabel("runtime.warning", payload)).toBeNull();
  });
});
