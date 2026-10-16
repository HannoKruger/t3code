import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  USAGE_PAUSE_ACTIVITY_KIND,
  describeUsagePause,
  formatUsagePauseTime,
  readUsagePausePayload,
  usagePauseWindowName,
  type UsagePausePayload,
} from "@t3tools/shared/usagePause";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  findUsagePauseLimit,
  nextUsagePauseDeadline,
  planUsagePauseAction,
  usagePauseLimitKey,
  type UsagePauseAction,
  type UsagePauseRecord,
  type UsagePauseThread,
} from "./UsagePausePolicy.ts";

/**
 * Pauses running Claude threads before the account hits a usage limit and
 * resumes them after the limit resets. The pause is the chat activity itself,
 * so a restart picks up every pending resume from the projection.
 */
export class UsagePauseReactor extends Context.Service<
  UsagePauseReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** @internal Exported for tests. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration/UsagePauseReactor") {}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const wrapUpMessage = (payload: UsagePausePayload) =>
  `[Usage pause] Claude ${usagePauseWindowName(payload)} usage is at ${Math.round(payload.usedPercent)}%. ` +
  "Stop now: do not start new work, tools or subagents, and stop every subagent and background task that is still running. " +
  "Reply with a short note of where you are and what is left, then end your turn. " +
  "This thread resumes automatically after the limit resets.";
const RESUME_MESSAGE =
  "[Usage pause] The Claude usage limit has reset. Continue from where you paused, using your note above.";

interface RecordedPause extends UsagePauseRecord {
  readonly threadId: ThreadId;
  readonly windowId: string;
}

function readRecordedPause(activity: OrchestrationThreadActivity): RecordedPause | null {
  const payload = readUsagePausePayload(activity.payload);
  const threadId = (activity.payload as { readonly threadId?: unknown } | null)?.threadId;
  if (payload === null || typeof threadId !== "string") return null;
  return {
    id: activity.id,
    threadId: ThreadId.make(threadId),
    windowId: payload.windowId,
    createdAt: activity.createdAt,
    resetsAt: payload.resetsAt,
    resumeAt: payload.resumeAt,
  };
}

function readRecordedPauses(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<RecordedPause> {
  return activities.flatMap((activity) => readRecordedPause(activity) ?? []);
}

function latestPauseByThread(pauses: ReadonlyArray<RecordedPause>): Map<ThreadId, RecordedPause> {
  const latest = new Map<ThreadId, RecordedPause>();
  for (const pause of pauses) {
    const current = latest.get(pause.threadId);
    if (current === undefined || Date.parse(pause.createdAt) > Date.parse(current.createdAt)) {
      latest.set(pause.threadId, pause);
    }
  }
  return latest;
}

/** A thread starting or stopping, a message, or a recorded pause can change what the pause does. */
function changesUsagePause(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.session-set":
    case "thread.message-sent":
      return true;
    case "thread.activity-appended":
      return event.payload.activity.kind === USAGE_PAUSE_ACTIVITY_KIND;
    default:
      return false;
  }
}

function providerInstanceOf(thread: OrchestrationThreadShell): ProviderInstanceId {
  return thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
}

/** Working means spending usage: a running turn, or subagents and background tasks a finished turn left behind. */
function isRunning(thread: OrchestrationThreadShell): boolean {
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    (thread.backgroundLiveness ?? null) !== null
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  // Limits this server has seen while enabled. The recorded pauses carry them across restarts.
  const enforcedLimitKeys = new Set<string>();

  const pauseThread = Effect.fnUntraced(function* (
    thread: OrchestrationThreadShell,
    action: Extract<UsagePauseAction, { readonly type: "pause" }>,
    createdAt: string,
  ) {
    const payload: UsagePausePayload = { ...action.limit, resumeAt: action.resumeAt };
    const pauseKey = `${thread.id}:${action.limit.resetsAt}`;
    if (action.steer) {
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:usage-pause:${pauseKey}`),
        threadId: thread.id,
        message: {
          messageId: MessageId.make(`usage-pause:${pauseKey}`),
          role: "user",
          text: wrapUpMessage(payload),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      });
    }
    // Same timestamp as the wrap-up message, so that message does not count as the user taking over.
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:usage-pause-activity:${pauseKey}`),
      threadId: thread.id,
      activity: {
        id: EventId.make(`usage-pause:${pauseKey}`),
        tone: "info",
        kind: USAGE_PAUSE_ACTIVITY_KIND,
        summary: describeUsagePause(payload, (instant) => formatUsagePauseTime(instant, "UTC")),
        payload: { ...payload, threadId: thread.id },
        turnId: thread.session?.activeTurnId ?? null,
        createdAt,
      },
      createdAt,
    });
  });

  const applyAction = Effect.fnUntraced(function* (
    thread: OrchestrationThreadShell,
    action: UsagePauseAction,
    createdAt: string,
  ) {
    switch (action.type) {
      case "pause":
        return yield* pauseThread(thread, action, createdAt);
      case "interrupt":
        // Without a turn there is nothing to interrupt, so stopping the session ends the
        // subagents and background tasks; the resume starts it again.
        return yield* engine.dispatch(
          action.turnId === null
            ? {
                type: "thread.session.stop",
                commandId: CommandId.make(`server:usage-pause-stop:${action.pauseId}`),
                threadId: thread.id,
                createdAt,
              }
            : {
                type: "thread.turn.interrupt",
                commandId: CommandId.make(`server:usage-pause-interrupt:${action.pauseId}`),
                threadId: thread.id,
                turnId: action.turnId,
                createdAt,
              },
        );
      case "resume":
        return yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`server:usage-resume:${action.pauseId}`),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(`usage-resume:${action.pauseId}`),
            role: "user",
            text: RESUME_MESSAGE,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt,
        });
    }
  });

  const decideAndApply = (
    thread: OrchestrationThreadShell,
    candidate: UsagePauseThread,
    now: DateTime.Utc,
  ) => {
    const action = planUsagePauseAction(candidate, DateTime.toEpochMillis(now));
    if (action === null) return Effect.void;
    return applyAction(thread, action, DateTime.formatIso(now)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("usage pause action failed", {
              threadId: thread.id,
              action: action.type,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  };

  /** Wakes the worker at the next grace or resume deadline; every other change arrives as an event. */
  const setAlarm = (deadlines: ReadonlyArray<number>, nowMs: number) => {
    const upcoming = deadlines.filter((deadline) => deadline > nowMs);
    if (upcoming.length === 0) return FiberHandle.clear(alarm);
    return FiberHandle.run(
      alarm,
      Effect.sleep(Duration.millis(Math.min(...upcoming) - nowMs)).pipe(
        Effect.andThen(Effect.suspend(() => worker.enqueue(undefined))),
      ),
    );
  };

  const sweep: Effect.Effect<void> = Effect.gen(function* () {
    const settings = (yield* settingsService.getSettings).claudeUsagePause;
    if (!settings.enabled) return;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const snapshot = yield* snapshots.getShellSnapshot({ unsettledOnly: true });
    const recordedPauses = readRecordedPauses(
      yield* snapshots.listActivitiesByKind(USAGE_PAUSE_ACTIVITY_KIND),
    );
    const pauses = latestPauseByThread(recordedPauses);
    const threads = snapshot.threads.filter(
      (thread) => thread.archivedAt === null && (isRunning(thread) || pauses.has(thread.id)),
    );
    const providers = (yield* providerRegistry.getProviders).filter(
      (provider) => provider.driver === CLAUDE_DRIVER && provider.enabled,
    );
    const limitByInstance = new Map(
      providers.map((provider) => [
        provider.instanceId,
        findUsagePauseLimit(provider.usageLimits?.windows ?? [], settings, nowMs),
      ]),
    );
    const enforcedLimits = new Set([
      ...enforcedLimitKeys,
      ...recordedPauses.map(usagePauseLimitKey),
    ]);
    const candidates = threads.flatMap((thread) => {
      const instance = providerInstanceOf(thread);
      if (!limitByInstance.has(instance)) return [];
      const limit = limitByInstance.get(instance) ?? null;
      const candidate: UsagePauseThread = {
        id: thread.id,
        running: isRunning(thread),
        activeTurnId: thread.session?.activeTurnId ?? null,
        latestUserMessageAt: thread.latestUserMessageAt,
        limit,
        limitAlreadyEnforced: limit !== null && enforcedLimits.has(usagePauseLimitKey(limit)),
        latestPause: pauses.get(thread.id) ?? null,
      };
      return [{ thread, candidate }];
    });
    yield* Effect.forEach(
      candidates,
      ({ thread, candidate }) => decideAndApply(thread, candidate, now),
      { discard: true },
    );
    yield* setAlarm(
      candidates.flatMap(({ candidate }) => nextUsagePauseDeadline(candidate) ?? []),
      nowMs,
    );
    // Recorded even when nothing ran, so threads started from now on are left alone.
    for (const limit of limitByInstance.values()) {
      if (limit !== null) enforcedLimitKeys.add(usagePauseLimitKey(limit));
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("usage pause sweep failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.withSpan("UsagePauseReactor.sweep"),
  );

  const alarm = yield* FiberHandle.make<void, never>();
  const worker = yield* makeDrainableWorker(() => sweep);

  const start: UsagePauseReactor["Service"]["start"] = Effect.fn("UsagePauseReactor.start")(
    function* () {
      const domainEvents = yield* engine.subscribeDomainEvents;
      yield* forkParked(worker.enqueue(undefined));
      // Usage arrives with every Claude request and from provider probes.
      yield* forkParked(
        Stream.runForEach(providerRegistry.streamChanges, () => worker.enqueue(undefined)),
      );
      yield* forkParked(
        Stream.runForEach(domainEvents, (event) =>
          changesUsagePause(event) ? worker.enqueue(undefined) : Effect.void,
        ),
      );
    },
  );

  return { start, drain: worker.drain, sweep } satisfies UsagePauseReactor["Service"];
});

export const layer = Layer.effect(UsagePauseReactor, make);
