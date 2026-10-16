// @effect-diagnostics globalDate:off -- Formats an instant for display in the viewer's zone via Intl.
/**
 * The chat line a thread shows when it is paused near a Claude usage limit.
 *
 * The server sends it as the wrap-up message with an id starting `usage-pause:` and the resume
 * time in UTC. Clients show that time in the viewer's own zone instead.
 */
const USAGE_PAUSE_MESSAGE_PREFIX = "usage-pause:";
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

export interface UsagePauseDescription {
  readonly windowId: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resumeAt: string;
}

function windowName(pause: UsagePauseDescription): string {
  return pause.windowId === "five_hour" ? "5-hour" : pause.label.toLowerCase();
}

export function describeUsagePause(
  pause: UsagePauseDescription,
  formatTime: (instant: string) => string,
): string {
  return `Paused: Claude ${windowName(pause)} usage is at ${Math.round(pause.usedPercent)}%. Resumes automatically ${formatTime(pause.resumeAt)}.`;
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

/** A pause message as the viewer should read it; every other message is returned unchanged. */
export function localizeUsagePauseMessage(messageId: string, text: string): string {
  if (!messageId.startsWith(USAGE_PAUSE_MESSAGE_PREFIX)) return text;
  return text.replace(ISO_INSTANT, (instant) => formatUsagePauseTime(instant));
}
