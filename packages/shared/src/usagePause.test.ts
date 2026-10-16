import { describe, expect, it } from "vite-plus/test";

import {
  describeUsagePause,
  formatUsagePauseTime,
  localizeUsagePauseMessage,
} from "./usagePause.ts";

const pause = {
  windowId: "five_hour",
  label: "Session",
  usedPercent: 90.4,
  resumeAt: "2026-10-14T12:02:00.000Z",
};

describe("describeUsagePause", () => {
  it("names the window and when work resumes", () => {
    expect(describeUsagePause(pause, () => "12:02")).toBe(
      "Paused: Claude 5-hour usage is at 90%. Resumes automatically 12:02.",
    );
  });

  it("names the weekly window", () => {
    expect(
      describeUsagePause({ ...pause, windowId: "seven_day", label: "Weekly" }, () => "x"),
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

describe("localizeUsagePauseMessage", () => {
  const text = `${describeUsagePause(pause, (instant) => instant)}\n\nStop now.`;

  it("shows a pause message's resume time in the viewer's zone", () => {
    expect(
      localizeUsagePauseMessage("usage-pause:t:five_hour:2026-10-14T12:00:00.000Z", text),
    ).toBe(
      `Paused: Claude 5-hour usage is at 90%. Resumes automatically ${formatUsagePauseTime(pause.resumeAt)}.\n\nStop now.`,
    );
  });

  it("leaves every other message alone", () => {
    expect(localizeUsagePauseMessage("message-1", text)).toBe(text);
  });
});
