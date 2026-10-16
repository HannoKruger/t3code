import type { RunId, ServerProviderUsageWindow, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** How long a paused agent gets to write its note and end the run before it is interrupted. */
export const USAGE_PAUSE_GRACE_MS = 3 * 60 * 1_000;
/** Resume a little after the reset so the provider has reported the fresh window. */
export const USAGE_PAUSE_RESUME_DELAY_MS = 2 * 60 * 1_000;
const USAGE_PAUSE_MESSAGE_PREFIX = "usage-pause:";

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

/** A pause recorded on a thread by its wrap-up message. */
export interface UsagePauseRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly resetsAt: string;
  readonly resumeAt: string;
  readonly resumed: boolean;
}

export interface UsagePauseThread {
  readonly id: ThreadId;
  /** A live run, or subagents and background tasks a finished run left behind. */
  readonly working: boolean;
  /** The run whose interrupt stops the thread's work, including its background tasks. */
  readonly interruptRunId: RunId | null;
  readonly latestUserAuthoredMessageAt: string | null;
  /** The limit the thread's provider account is over right now, if any. */
  readonly limit: UsagePauseLimit | null;
  /** The pause already acted on this limit, so work now was started after the limit was reached. */
  readonly limitAlreadyEnforced: boolean;
  readonly latestPause: UsagePauseRecord | null;
}

export type UsagePauseAction =
  | {
      readonly type: "pause";
      readonly threadId: ThreadId;
      readonly limit: UsagePauseLimit;
      readonly resumeAt: string;
    }
  | {
      readonly type: "interrupt";
      readonly threadId: ThreadId;
      readonly pauseId: string;
      readonly runId: RunId;
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

/** A window whose reset has passed still shows the old percentage until the next report. */
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

export function usagePauseLimitKey(limit: Pick<UsagePauseLimit, "windowId" | "resetsAt">): string {
  return `${limit.windowId}:${limit.resetsAt}`;
}

function resumeAtFor(resetsAt: string): string {
  return DateTime.formatIso(
    DateTime.makeUnsafe(Date.parse(resetsAt) + USAGE_PAUSE_RESUME_DELAY_MS),
  );
}

/** The wrap-up message id is the durable pause record: one per thread, window and reset. */
export function usagePauseMessageId(threadId: ThreadId, limit: UsagePauseLimit): string {
  return `${USAGE_PAUSE_MESSAGE_PREFIX}${threadId}:${limit.windowId}:${limit.resetsAt}`;
}

export function usageResumeMessageId(pauseId: string): string {
  return `usage-resume:${pauseId}`;
}

/** Thread ids may contain colons, so the id is read after the thread the message belongs to. */
export function readUsagePauseMessageId(
  threadId: ThreadId,
  messageId: string,
): {
  readonly windowId: string;
  readonly resetsAt: string;
  readonly resumeAt: string;
} | null {
  const threadPrefix = `${USAGE_PAUSE_MESSAGE_PREFIX}${threadId}:`;
  if (!messageId.startsWith(threadPrefix)) return null;
  const limitKey = messageId.slice(threadPrefix.length);
  const separator = limitKey.indexOf(":");
  if (separator <= 0) return null;
  const resetsAt = limitKey.slice(separator + 1);
  if (Number.isNaN(Date.parse(resetsAt))) return null;
  return {
    windowId: limitKey.slice(0, separator),
    resetsAt,
    resumeAt: resumeAtFor(resetsAt),
  };
}

/** The resume message, or any message the user wrote after the pause, ends it. */
function isOpen(thread: UsagePauseThread, pause: UsagePauseRecord): boolean {
  return (
    !pause.resumed &&
    (thread.latestUserAuthoredMessageAt === null ||
      Date.parse(thread.latestUserAuthoredMessageAt) <= Date.parse(pause.createdAt))
  );
}

export function planUsagePauseAction(
  thread: UsagePauseThread,
  nowMs: number,
): UsagePauseAction | null {
  const pause = thread.latestPause;
  if (pause !== null && isOpen(thread, pause)) {
    if (thread.working) {
      return nowMs >= Date.parse(pause.createdAt) + USAGE_PAUSE_GRACE_MS &&
        thread.interruptRunId !== null
        ? {
            type: "interrupt",
            threadId: thread.id,
            pauseId: pause.id,
            runId: thread.interruptRunId,
          }
        : null;
    }
    return nowMs >= Date.parse(pause.resumeAt) && thread.limit === null
      ? { type: "resume", threadId: thread.id, pauseId: pause.id }
      : null;
  }
  // Only work running when the limit was reached is paused. A thread the user kept running
  // after its pause, or started afterwards, is theirs until the window resets.
  if (
    !thread.working ||
    thread.limit === null ||
    thread.limitAlreadyEnforced ||
    pause?.resetsAt === thread.limit.resetsAt
  ) {
    return null;
  }
  return {
    type: "pause",
    threadId: thread.id,
    limit: thread.limit,
    resumeAt: resumeAtFor(thread.limit.resetsAt),
  };
}

/**
 * When this thread's decision next changes with time alone: the end of the grace period while a
 * paused thread still works, or its resume time once it has stopped, later if another window is
 * still over its limit. Everything else changes only through an event.
 */
export function nextUsagePauseDeadline(thread: UsagePauseThread): number | null {
  const pause = thread.latestPause;
  if (pause === null || !isOpen(thread, pause)) return null;
  if (thread.working) return Date.parse(pause.createdAt) + USAGE_PAUSE_GRACE_MS;
  const resumeAt = Date.parse(pause.resumeAt);
  return thread.limit === null
    ? resumeAt
    : Math.max(resumeAt, Date.parse(resumeAtFor(thread.limit.resetsAt)));
}
