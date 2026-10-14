import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import { USAGE_PAUSE_ACTIVITY_KIND } from "@t3tools/shared/usagePause";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as UsagePauseReactor from "./UsagePauseReactor.ts";

const NOW = "2026-10-14T10:00:00.000Z";
const SESSION_RESET = "2026-10-14T12:00:00.000Z";
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const THREAD_ID = ThreadId.make("thread-1");

const sessionWindow = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt: SESSION_RESET,
});

const makeProvider = (
  instanceId: ProviderInstanceId,
  driver: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: { checkedAt: NOW, windows },
});

const makeThread = (
  overrides: Partial<OrchestrationThreadShell> & { readonly running?: boolean } = {},
): OrchestrationThreadShell => {
  const { running = true, ...rest } = overrides;
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude-haiku-4-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-10-14T08:00:00.000Z",
    updatedAt: "2026-10-14T09:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId: THREAD_ID,
      status: running ? "running" : "ready",
      providerName: "claudeAgent",
      providerInstanceId: CLAUDE_INSTANCE,
      runtimeMode: "full-access",
      activeTurnId: running ? TurnId.make("turn-1") : null,
      lastError: null,
      updatedAt: "2026-10-14T09:00:00.000Z",
    },
    latestUserMessageAt: "2026-10-14T09:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...rest,
  };
};

const pauseActivity = (createdAt: string, resumeAt: string): OrchestrationThreadActivity => ({
  id: EventId.make(`usage-pause:${THREAD_ID}:${SESSION_RESET}`),
  tone: "info",
  kind: USAGE_PAUSE_ACTIVITY_KIND,
  summary: "Paused",
  payload: {
    threadId: THREAD_ID,
    windowId: "five_hour",
    label: "Session",
    usedPercent: 91,
    resetsAt: SESSION_RESET,
    resumeAt,
  },
  turnId: null,
  createdAt,
});

const runSweep = (input: {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  /** Threads seen by later sweeps of the same reactor, one entry per sweep. */
  readonly laterSweeps?: ReadonlyArray<ReadonlyArray<OrchestrationThreadShell>>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
  readonly settings?: ServerSettings;
  readonly now?: string;
  /** Time that passes after the sweeps, with no other event, before commands are read. */
  readonly thenWait?: Duration.Input;
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(input.now ?? NOW));
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const visibleThreads = yield* Ref.make(input.threads);
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Ref.get(visibleThreads).pipe(
            Effect.map((threads) => ({
              snapshotSequence: 1,
              projects: [],
              threads,
              updatedAt: NOW,
            })),
          ),
        listActivitiesByKind: () => Effect.succeed(input.activities ?? []),
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed(input.providers),
        refreshInstance: () => Effect.succeed(input.providers),
        streamChanges: Stream.empty,
      }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Ref.update(commands, (recorded) => [...recorded, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed(input.settings ?? DEFAULT_SERVER_SETTINGS),
      }),
    );
    const reactor = yield* UsagePauseReactor.make.pipe(Effect.provide(dependencies));
    yield* reactor.sweep;
    for (const threads of input.laterSweeps ?? []) {
      yield* Ref.set(visibleThreads, threads);
      yield* reactor.sweep;
    }
    if (input.thenWait !== undefined) {
      yield* TestClock.adjust(input.thenWait);
      yield* reactor.drain;
    }
    return yield* Ref.get(commands);
  }).pipe(Effect.scoped);

describe("UsagePauseReactor", () => {
  it.effect("asks a running Claude thread to wrap up and records when it resumes", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [makeThread()],
        providers: [makeProvider(CLAUDE_INSTANCE, "claudeAgent", [sessionWindow(91)])],
      });
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.turn.start", "thread.activity.append"],
      );
      const [steer, record] = commands;
      assert(steer?.type === "thread.turn.start");
      assert.include(steer.message.text, "usage is at 91%");
      assert.strictEqual(steer.runtimeMode, "full-access");
      assert(record?.type === "thread.activity.append");
      assert.strictEqual(record.activity.kind, USAGE_PAUSE_ACTIVITY_KIND);
      assert.strictEqual(record.activity.createdAt, steer.createdAt);
      assert.deepInclude(record.activity.payload as object, {
        threadId: THREAD_ID,
        resumeAt: "2026-10-14T12:02:00.000Z",
      });
    }),
  );

  it.effect("leaves a thread started after the limit was reached running", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [makeThread({ running: false })],
        laterSweeps: [[makeThread()]],
        providers: [makeProvider(CLAUDE_INSTANCE, "claudeAgent", [sessionWindow(91)])],
      });
      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("remembers an enforced limit across restarts through the recorded pauses", () =>
    Effect.gen(function* () {
      const otherThreadPause = {
        ...pauseActivity("2026-10-14T09:50:00.000Z", "2026-10-14T12:02:00.000Z"),
        id: EventId.make("usage-pause:thread-2:2026-10-14T12:00:00.000Z"),
        payload: {
          threadId: "thread-2",
          windowId: "five_hour",
          label: "Session",
          usedPercent: 91,
          resetsAt: SESSION_RESET,
          resumeAt: "2026-10-14T12:02:00.000Z",
        },
      };
      const commands = yield* runSweep({
        threads: [makeThread()],
        providers: [makeProvider(CLAUDE_INSTANCE, "claudeAgent", [sessionWindow(91)])],
        activities: [otherThreadPause],
      });
      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("leaves threads on other providers running", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [
          makeThread({
            modelSelection: { instanceId: CODEX_INSTANCE, model: "gpt-5" },
            session: null,
          }),
        ],
        providers: [makeProvider(CODEX_INSTANCE, "codex", [sessionWindow(99)])],
      });
      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("does nothing when the pause is turned off", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [makeThread()],
        providers: [makeProvider(CLAUDE_INSTANCE, "claudeAgent", [sessionWindow(99)])],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          claudeUsagePause: { ...DEFAULT_SERVER_SETTINGS.claudeUsagePause, enabled: false },
        },
      });
      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("stops a thread still running after the grace period", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [makeThread({ latestUserMessageAt: "2026-10-14T09:50:00.000Z" })],
        providers: [makeProvider(CLAUDE_INSTANCE, "claudeAgent", [sessionWindow(95)])],
        activities: [pauseActivity("2026-10-14T09:50:00.000Z", "2026-10-14T12:02:00.000Z")],
      });
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.turn.interrupt"],
      );
    }),
  );

  it.effect("stops a paused thread when its grace period ends, without another event", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        now: "2026-10-14T09:51:00.000Z",
        threads: [makeThread({ latestUserMessageAt: "2026-10-14T09:50:00.000Z" })],
        providers: [makeProvider(CLAUDE_INSTANCE, "claudeAgent", [sessionWindow(95)])],
        activities: [pauseActivity("2026-10-14T09:50:00.000Z", "2026-10-14T12:02:00.000Z")],
        thenWait: "2 minutes",
      });
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.turn.interrupt"],
      );
    }),
  );

  it.effect("resumes the thread after the window resets", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        now: "2026-10-14T12:03:00.000Z",
        threads: [makeThread({ running: false, latestUserMessageAt: "2026-10-14T09:50:00.000Z" })],
        providers: [makeProvider(CLAUDE_INSTANCE, "claudeAgent", [sessionWindow(95)])],
        activities: [pauseActivity("2026-10-14T09:50:00.000Z", "2026-10-14T12:02:00.000Z")],
      });
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.turn.start"],
      );
      const [resume] = commands;
      assert(resume?.type === "thread.turn.start");
      assert.include(resume.message.text, "limit has reset");
    }),
  );
});
