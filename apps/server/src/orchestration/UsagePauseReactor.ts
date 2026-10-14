import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ServerProvider,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  findUsagePauseLimit,
  isNearUsagePauseLimit,
  planUsagePauseAction,
  type UsagePauseAction,
  type UsagePauseRecord,
  type UsagePauseThresholds,
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
/** Usage probes spawn the provider CLI, so near a limit they run at most this often. */
const NEAR_LIMIT_REFRESH_MS = 60 * 1_000;

const wrapUpMessage = (payload: UsagePausePayload) =>
  `[Usage pause] Claude ${usagePauseWindowName(payload)} usage is at ${Math.round(payload.usedPercent)}%. ` +
  "Stop now: do not start new work, tools or subagents, and stop any subagents that are running. " +
  "Reply with a short note of where you are and what is left, then end your turn. " +
  "This thread resumes automatically after the limit resets.";
const RESUME_MESSAGE =
  "[Usage pause] The Claude usage limit has reset. Continue from where you paused, using your note above.";

interface RecordedPause extends UsagePauseRecord {
  readonly threadId: ThreadId;
}

function readRecordedPause(activity: OrchestrationThreadActivity): RecordedPause | null {
  const payload = readUsagePausePayload(activity.payload);
  const threadId = (activity.payload as { readonly threadId?: unknown } | null)?.threadId;
  if (payload === null || typeof threadId !== "string") return null;
  return {
    id: activity.id,
    threadId: ThreadId.make(threadId),
    createdAt: activity.createdAt,
    resetsAt: payload.resetsAt,
    resumeAt: payload.resumeAt,
  };
}

function latestPauseByThread(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<ThreadId, RecordedPause> {
  const latest = new Map<ThreadId, RecordedPause>();
  for (const activity of activities) {
    const pause = readRecordedPause(activity);
    if (pause === null) continue;
    const current = latest.get(pause.threadId);
    if (current === undefined || Date.parse(pause.createdAt) > Date.parse(current.createdAt)) {
      latest.set(pause.threadId, pause);
    }
  }
  return latest;
}

function providerInstanceOf(thread: OrchestrationThreadShell): ProviderInstanceId {
  return thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
}

function isRunning(thread: OrchestrationThreadShell): boolean {
  return thread.session?.status === "running" || thread.session?.status === "starting";
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const lastRefreshByInstance = new Map<ProviderInstanceId, number>();

  /** The regular probe runs every few minutes, which is too slow near a limit. */
  const refreshNearLimit = Effect.fnUntraced(function* (
    providers: ReadonlyArray<ServerProvider>,
    runningInstances: ReadonlySet<ProviderInstanceId>,
    thresholds: UsagePauseThresholds,
    nowMs: number,
  ) {
    let refreshed = providers;
    for (const provider of providers) {
      const windows = provider.usageLimits?.windows ?? [];
      const lastRefresh = lastRefreshByInstance.get(provider.instanceId) ?? 0;
      if (
        !runningInstances.has(provider.instanceId) ||
        !isNearUsagePauseLimit(windows, thresholds, nowMs) ||
        nowMs - lastRefresh < NEAR_LIMIT_REFRESH_MS
      ) {
        continue;
      }
      lastRefreshByInstance.set(provider.instanceId, nowMs);
      refreshed = yield* providerRegistry.refreshInstance(provider.instanceId);
    }
    return refreshed.filter((provider) => provider.driver === CLAUDE_DRIVER && provider.enabled);
  });

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
        return yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`server:usage-pause-interrupt:${action.pauseId}`),
          threadId: thread.id,
          ...(action.turnId === null ? {} : { turnId: action.turnId }),
          createdAt,
        });
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
    provider: ServerProvider,
    latestPause: RecordedPause | null,
    thresholds: UsagePauseThresholds,
    now: DateTime.Utc,
  ) => {
    const nowMs = DateTime.toEpochMillis(now);
    const action = planUsagePauseAction(
      {
        id: thread.id,
        running: isRunning(thread),
        activeTurnId: thread.session?.activeTurnId ?? null,
        latestUserMessageAt: thread.latestUserMessageAt,
        limit: findUsagePauseLimit(provider.usageLimits?.windows ?? [], thresholds, nowMs),
        latestPause,
      },
      nowMs,
    );
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

  const sweep = Effect.gen(function* () {
    const settings = (yield* settingsService.getSettings).claudeUsagePause;
    if (!settings.enabled) return;
    const now = yield* DateTime.now;
    const snapshot = yield* snapshots.getShellSnapshot({ unsettledOnly: true });
    const pauses = latestPauseByThread(
      yield* snapshots.listActivitiesByKind(USAGE_PAUSE_ACTIVITY_KIND),
    );
    const threads = snapshot.threads.filter(
      (thread) => thread.archivedAt === null && (isRunning(thread) || pauses.has(thread.id)),
    );
    if (threads.length === 0) return;
    const providers = yield* refreshNearLimit(
      yield* providerRegistry.getProviders,
      new Set(threads.filter(isRunning).map(providerInstanceOf)),
      settings,
      DateTime.toEpochMillis(now),
    );
    const providerByInstance = new Map(
      providers.map((provider) => [provider.instanceId, provider]),
    );
    yield* Effect.forEach(
      threads,
      (thread) => {
        const provider = providerByInstance.get(providerInstanceOf(thread));
        return provider === undefined
          ? Effect.void
          : decideAndApply(thread, provider, pauses.get(thread.id) ?? null, settings, now);
      },
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("usage pause sweep failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.withSpan("UsagePauseReactor.sweep"),
  );

  const worker = yield* makeDrainableWorker(() => sweep);

  const start: UsagePauseReactor["Service"]["start"] = Effect.fn("UsagePauseReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.asVoid),
      );
      // Usage arrives mid-turn as well as from probes; react to it rather than waiting for the timer.
      yield* forkParked(
        Stream.runForEach(providerRegistry.streamChanges, () => worker.enqueue(undefined)),
      );
    },
  );

  return { start, drain: worker.drain, sweep } satisfies UsagePauseReactor["Service"];
});

export const layer = Layer.effect(UsagePauseReactor, make);
