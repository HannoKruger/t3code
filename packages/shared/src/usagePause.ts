// @effect-diagnostics globalDate:off -- Formats an instant for display in the viewer's zone via Intl.
/**
 * The chat line a thread shows while it is paused near a Claude usage limit.
 *
 * The server stores the pause as a thread activity of `USAGE_PAUSE_ACTIVITY_KIND`
 * with a `UsagePausePayload`. Clients rebuild the label from the payload so the
 * resume time renders in the viewer's own time zone; the stored summary is the
 * fallback for surfaces that only show it.
 */
export const USAGE_PAUSE_ACTIVITY_KIND = "usage-pause.paused";

export interface UsagePausePayload {
  readonly windowId: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string;
  readonly resumeAt: string;
}

export function readUsagePausePayload(payload: unknown): UsagePausePayload | null {
  if (payload === null || typeof payload !== "object") return null;
  const { windowId, label, usedPercent, resetsAt, resumeAt } = payload as Record<string, unknown>;
  if (
    typeof windowId !== "string" ||
    typeof label !== "string" ||
    typeof usedPercent !== "number" ||
    typeof resetsAt !== "string" ||
    typeof resumeAt !== "string"
  ) {
    return null;
  }
  return { windowId, label, usedPercent, resetsAt, resumeAt };
}

export function usagePauseWindowName(payload: UsagePausePayload): string {
  return payload.windowId === "five_hour" ? "5-hour" : payload.label.toLowerCase();
}

export function describeUsagePause(
  payload: UsagePausePayload,
  formatTime: (instant: string) => string,
): string {
  return `Paused: Claude ${usagePauseWindowName(payload)} usage is at ${Math.round(payload.usedPercent)}%. Resumes automatically ${formatTime(payload.resumeAt)}.`;
}

/** `2026-10-14T12:02:00Z` to `Wed, Oct 14, 2:02 PM GMT+2`, in the viewer's zone by default. */
export function formatUsagePauseTime(instant: string, timeZone?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

/** The label clients show for a pause activity, or null for any other activity. */
export function usagePauseActivityLabel(kind: string, payload: unknown): string | null {
  if (kind !== USAGE_PAUSE_ACTIVITY_KIND) return null;
  const pause = readUsagePausePayload(payload);
  return pause === null
    ? null
    : describeUsagePause(pause, (instant) => formatUsagePauseTime(instant));
}
