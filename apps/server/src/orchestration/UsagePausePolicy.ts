import type { ServerProviderUsageWindow, ThreadId, TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** How long a paused agent gets to write its note and end the turn before it is interrupted. */
export const USAGE_PAUSE_GRACE_MS = 3 * 60 * 1_000;
/** Resume a little after the reset so the provider has reported the fresh window. */
export const USAGE_PAUSE_RESUME_DELAY_MS = 2 * 60 * 1_000;
/** Within this many points of a threshold, usage is refreshed every sweep instead of every few minutes. */
const NEAR_LIMIT_MARGIN_PERCENT = 10;

export interface UsagePauseThresholds {
  readonly sessionPercent: number;
  readonly weeklyPercent: number;
}

/** The window that forced a pause. */
export interface UsagePauseLimit {
  readonly windowId: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string;
}

/** A pause the server recorded on a thread. */
export interface UsagePauseRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly resetsAt: string;
  readonly resumeAt: string;
}

export interface UsagePauseThread {
  readonly id: ThreadId;
  readonly running: boolean;
  readonly activeTurnId: TurnId | null;
  readonly latestUserMessageAt: string | null;
  /** The limit the thread's provider account is over right now, if any. */
  readonly limit: UsagePauseLimit | null;
  readonly latestPause: UsagePauseRecord | null;
}

export type UsagePauseAction =
  | {
      readonly type: "pause";
      readonly threadId: ThreadId;
      readonly limit: UsagePauseLimit;
      readonly resumeAt: string;
      /** Whether a running agent must be told to wrap up. */
      readonly steer: boolean;
    }
  | {
      readonly type: "interrupt";
      readonly threadId: ThreadId;
      readonly pauseId: string;
      readonly turnId: TurnId | null;
    }
  | { readonly type: "resume"; readonly threadId: ThreadId; readonly pauseId: string };

/**
 * Only the account-wide windows pause work. Model-scoped weeklies stop one
 * model, not the account, so they would pause threads that can keep going.
 */
function thresholdFor(windowId: string, thresholds: UsagePauseThresholds): number | null {
  if (windowId === "five_hour") return thresholds.sessionPercent;
  if (windowId === "seven_day") return thresholds.weeklyPercent;
  return null;
}

/** A window whose reset has passed still shows the old percentage until the next probe. */
function isCurrent(
  window: ServerProviderUsageWindow,
  nowMs: number,
): window is ServerProviderUsageWindow & { readonly resetsAt: string } {
  return window.resetsAt !== undefined && Date.parse(window.resetsAt) > nowMs;
}

/** The over-threshold window that resets last, because work can only resume once all of them have. */
export function findUsagePauseLimit(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  thresholds: UsagePauseThresholds,
  nowMs: number,
): UsagePauseLimit | null {
  let latest: UsagePauseLimit | null = null;
  for (const window of windows) {
    const threshold = thresholdFor(window.id, thresholds);
    if (threshold === null || !isCurrent(window, nowMs) || window.usedPercent < threshold) {
      continue;
    }
    if (latest === null || Date.parse(window.resetsAt) > Date.parse(latest.resetsAt)) {
      latest = {
        windowId: window.id,
        label: window.label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
      };
    }
  }
  return latest;
}

export function isNearUsagePauseLimit(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  thresholds: UsagePauseThresholds,
  nowMs: number,
): boolean {
  return windows.some((window) => {
    const threshold = thresholdFor(window.id, thresholds);
    return (
      threshold !== null &&
      isCurrent(window, nowMs) &&
      window.usedPercent >= threshold - NEAR_LIMIT_MARGIN_PERCENT
    );
  });
}

function resumeAtFor(limit: UsagePauseLimit): string {
  return DateTime.formatIso(
    DateTime.makeUnsafe(Date.parse(limit.resetsAt) + USAGE_PAUSE_RESUME_DELAY_MS),
  );
}

/** Any message after the pause (the user's own, or the resume) ends it. */
function isOpen(thread: UsagePauseThread, pause: UsagePauseRecord): boolean {
  return (
    thread.latestUserMessageAt === null ||
    Date.parse(thread.latestUserMessageAt) <= Date.parse(pause.createdAt)
  );
}

export function planUsagePauseAction(
  thread: UsagePauseThread,
  nowMs: number,
): UsagePauseAction | null {
  const pause = thread.latestPause;
  if (pause !== null && isOpen(thread, pause)) {
    if (thread.running) {
      return nowMs >= Date.parse(pause.createdAt) + USAGE_PAUSE_GRACE_MS
        ? { type: "interrupt", threadId: thread.id, pauseId: pause.id, turnId: thread.activeTurnId }
        : null;
    }
    if (nowMs < Date.parse(pause.resumeAt)) return null;
    if (thread.limit === null) return { type: "resume", threadId: thread.id, pauseId: pause.id };
    return thread.limit.resetsAt === pause.resetsAt
      ? null
      : {
          type: "pause",
          threadId: thread.id,
          limit: thread.limit,
          resumeAt: resumeAtFor(thread.limit),
          steer: false,
        };
  }
  // A thread the user kept running after its pause is theirs until the window resets.
  if (!thread.running || thread.limit === null || pause?.resetsAt === thread.limit.resetsAt) {
    return null;
  }
  return {
    type: "pause",
    threadId: thread.id,
    limit: thread.limit,
    resumeAt: resumeAtFor(thread.limit),
    steer: true,
  };
}
