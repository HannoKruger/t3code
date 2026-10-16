import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { describeUsagePause } from "@t3tools/shared/usagePause";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  findUsagePauseLimit,
  nextUsagePauseDeadline,
  planUsagePauseAction,
  readUsagePauseMessageId,
  usagePauseLimitKey,
  usagePauseMessageId,
  usageResumeMessageId,
  type UsagePauseAction,
  type UsagePauseRecord,
  type UsagePauseThread,
} from "./UsagePausePolicy.ts";

/**
 * Pauses Claude threads before the account hits a usage limit and resumes them after the limit
 * resets. The wrap-up message is the pause record, so a restart finds every pending resume in
 * the projection. Runs on events only, plus one alarm for the next grace or resume deadline.
 */
export class UsagePauseReactor extends Context.Service<
  UsagePauseReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /** @internal Exported for tests. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/UsagePauseReactor") {}

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const WRAP_UP_INSTRUCTIONS =
  "Stop now: do not start new work, tools or subagents, and stop every subagent and background task that is still running. " +
  "Reply with a short note of where you are and what is left, then end your turn.";
const RESUME_MESSAGE =
  "The Claude usage limit has reset. Continue from where you paused, using your note above.";

interface RecordedPause extends UsagePauseRecord {
  readonly threadId: ThreadId;
  readonly windowId: string;
}

/** Pause messages carry their thread, window and reset in the id; resume messages name the pause. */
function readRecordedPauses(
  pauseMessages: ReadonlyArray<{
    readonly messageId: string;
    readonly threadId: ThreadId;
    readonly createdAt: DateTime.Utc;
  }>,
  resumeMessageIds: ReadonlySet<string>,
): ReadonlyArray<RecordedPause> {
  return pauseMessages.flatMap((message) => {
    const pause = readUsagePauseMessageId(message.threadId, message.messageId);
    if (pause === null) return [];
    return [
      {
        id: message.messageId,
        threadId: message.threadId,
        windowId: pause.windowId,
        createdAt: DateTime.formatIso(message.createdAt),
        resetsAt: pause.resetsAt,
        resumeAt: pause.resumeAt,
        resumed: resumeMessageIds.has(usageResumeMessageId(message.messageId)),
      },
    ];
  });
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

/** Spending usage: a live run, or subagents and background tasks a finished run left behind. */
function isWorking(thread: OrchestrationV2ThreadShell): boolean {
  return thread.activeRunId !== null || (thread.pendingBackgroundTasks?.length ?? 0) > 0;
}

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value == null ? null : DateTime.formatIso(value);
}

/** Run, subagent and user-message changes can change what the pause does; streaming text cannot. */
function changesUsagePause(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "run.created":
    case "run.updated":
    case "run.background-work-cancelled":
    case "subagent.updated":
      return true;
    case "message.updated":
      return event.payload.role === "user";
    default:
      return false;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  // Limits this server has seen while enabled. The recorded pauses carry them across restarts.
  const enforcedLimitKeys = new Set<string>();

  const applyAction = Effect.fnUntraced(function* (
    thread: OrchestrationV2ThreadShell,
    action: UsagePauseAction,
  ) {
    switch (action.type) {
      case "pause": {
        const messageId = usagePauseMessageId(thread.id, action.limit);
        const notice = describeUsagePause(
          { ...action.limit, resumeAt: action.resumeAt },
          (instant) => instant,
        );
        // Steers a live run; a thread with only background work left gets a run to stop it in.
        return yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:${messageId}`),
          threadId: thread.id,
          messageId: MessageId.make(messageId),
          text: `${notice}\n\n${WRAP_UP_INSTRUCTIONS}`,
          attachments: [],
          deliveryIntent: "steer",
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        });
      }
      case "interrupt":
        // A run started after the interrupt gets its own command, so it is stopped too.
        return yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(
            `server:usage-pause-interrupt:${action.pauseId}:${action.runId}`,
          ),
          threadId: thread.id,
          runId: action.runId,
          reason: "Paused: Claude usage limit",
        });
      case "resume": {
        const messageId = usageResumeMessageId(action.pauseId);
        return yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:${messageId}`),
          threadId: thread.id,
          messageId: MessageId.make(messageId),
          text: RESUME_MESSAGE,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        });
      }
    }
  });

  const decideAndApply = (
    thread: OrchestrationV2ThreadShell,
    candidate: UsagePauseThread,
    nowMs: number,
  ) => {
    const action = planUsagePauseAction(candidate, nowMs);
    if (action === null) return Effect.void;
    return applyAction(thread, action).pipe(
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
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const snapshot = yield* threads.getShellSnapshot();
    const resumeMessageIds = new Set(
      (yield* projections.listMessagesWithIdPrefix("usage-resume:")).map(
        (message) => message.messageId,
      ),
    );
    const recordedPauses = readRecordedPauses(
      yield* projections.listMessagesWithIdPrefix("usage-pause:"),
      resumeMessageIds,
    );
    const pauses = latestPauseByThread(recordedPauses);
    const limitByInstance = new Map(
      (yield* providerRegistry.getProviders)
        .filter((provider) => provider.driver === CLAUDE_DRIVER && provider.enabled)
        .map((provider) => [
          provider.instanceId,
          findUsagePauseLimit(provider.usageLimits?.windows ?? [], settings, nowMs),
        ]),
    );
    const enforcedLimits = new Set([
      ...enforcedLimitKeys,
      ...recordedPauses.map(usagePauseLimitKey),
    ]);
    // Subagent threads stop with their parent's run, so only top-level threads are paused.
    const candidates = snapshot.threads.flatMap((thread) => {
      if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") {
        return [];
      }
      if (!limitByInstance.has(thread.providerInstanceId)) return [];
      const limit = limitByInstance.get(thread.providerInstanceId) ?? null;
      const candidate: UsagePauseThread = {
        id: thread.id,
        working: isWorking(thread),
        interruptRunId: thread.activeRunId ?? thread.latestRunId,
        latestUserAuthoredMessageAt: isoOrNull(thread.latestUserAuthoredMessageAt),
        limit,
        limitAlreadyEnforced: limit !== null && enforcedLimits.has(usagePauseLimitKey(limit)),
        latestPause: pauses.get(thread.id) ?? null,
      };
      return [{ thread, candidate }];
    });
    yield* Effect.forEach(
      candidates,
      ({ thread, candidate }) => decideAndApply(thread, candidate, nowMs),
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
      yield* forkParked(worker.enqueue(undefined));
      // Usage arrives with every Claude request and from provider probes.
      yield* forkParked(
        Stream.runForEach(providerRegistry.streamChanges, () => worker.enqueue(undefined)),
      );
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          changesUsagePause(event) ? worker.enqueue(undefined) : Effect.void,
        ),
      );
      yield* forkParked(
        Stream.runForEach(settingsService.streamChanges, () => worker.enqueue(undefined)),
      );
    },
  );

  return { start, drain: worker.drain, sweep } satisfies UsagePauseReactor["Service"];
});

export const layer = Layer.effect(UsagePauseReactor, make);
