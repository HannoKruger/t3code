import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import * as UsagePauseReactor from "./UsagePauseReactor.ts";

const NOW = "2026-10-14T10:00:00.000Z";
const SESSION_RESET = "2026-10-14T12:00:00.000Z";
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const THREAD_ID = ThreadId.make("thread-1");
const RUN_ID = RunId.make("run-1");
const PAUSE_ID = `usage-pause:${THREAD_ID}:five_hour:${SESSION_RESET}`;

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

const iso = (value: string) => DateTime.makeUnsafe(value);

const makeThread = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  providerInstanceId: CLAUDE_INSTANCE,
  modelSelection: { instanceId: CLAUDE_INSTANCE, model: "claude-haiku-4-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: RUN_ID,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  lastVisitedAt: null,
  deletedAt: null,
  branch: null,
  linkedPullRequest: null,
  status: "running",
  activityRunStatus: "running",
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: RUN_ID,
  latestRunRequestedAt: iso("2026-10-14T09:00:00.000Z"),
  latestRunStartedAt: iso("2026-10-14T09:00:00.000Z"),
  latestRunCompletedAt: null,
  latestUserMessageAt: iso("2026-10-14T09:00:00.000Z"),
  latestUserAuthoredMessageAt: iso("2026-10-14T09:00:00.000Z"),
  createdAt: iso("2026-10-14T08:00:00.000Z"),
  updatedAt: iso("2026-10-14T09:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  ...overrides,
});

const idle = { activeRunId: null, status: "completed", activityRunStatus: null } as const;

const runSweep = (input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Threads seen by later sweeps of the same worker, one entry per sweep. */
  readonly laterSweeps?: ReadonlyArray<ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Recorded pause and resume messages, by id and creation time. */
  readonly messages?: ReadonlyArray<{ readonly messageId: string; readonly createdAt: string }>;
  readonly settings?: ServerSettings;
  readonly now?: string;
  /** Time that passes after the sweeps, with no other event, before commands are read. */
  readonly thenWait?: Duration.Input;
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(input.now ?? NOW));
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const visibleThreads = yield* Ref.make(input.threads);
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagementService)({
        getShellSnapshot: () =>
          Ref.get(visibleThreads).pipe(
            Effect.map((threads) => ({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads,
              archivedThreads: [],
            })),
          ),
        dispatch: (command) =>
          Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({} as never)),
        streamDomainEvents: Stream.empty,
      }),
      Layer.mock(ProjectionStoreV2)({
        listMessagesWithIdPrefix: (prefix) =>
          Effect.succeed(
            (input.messages ?? [])
              .filter((message) => message.messageId.startsWith(prefix))
              .map((message) => ({
                messageId: message.messageId,
                threadId: THREAD_ID,
                createdAt: iso(message.createdAt),
              })),
          ),
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed(input.providers),
        streamChanges: Stream.empty,
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed(input.settings ?? DEFAULT_SERVER_SETTINGS),
        streamChanges: Stream.empty,
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

const claude = (usedPercent: number) => [
  makeProvider(CLAUDE_INSTANCE, "claudeAgent", [sessionWindow(usedPercent)]),
];

describe("UsagePauseReactor", () => {
  it.effect("steers a working Claude thread to wrap up with a durable pause message", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({ threads: [makeThread()], providers: claude(91) });
      assert.strictEqual(commands.length, 1);
      const [pause] = commands;
      assert(pause?.type === "message.dispatch");
      assert.strictEqual(pause.messageId, PAUSE_ID);
      assert.strictEqual(pause.deliveryIntent, "steer");
      assert.strictEqual(pause.createdBy, "agent");
      assert.include(
        pause.text,
        "Paused: Claude 5-hour usage is at 91%. Resumes automatically 2026-10-14T12:02:00.000Z.",
      );
    }),
  );

  it.effect("pauses a thread whose run ended while its background agents keep working", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [
          makeThread({
            ...idle,
            pendingBackgroundTasks: [{ kind: "subagent", taskId: "agent-1" }],
          }),
        ],
        providers: claude(95),
      });
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["message.dispatch"],
      );
    }),
  );

  it.effect("leaves idle threads, other providers and subagent threads alone", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [
          makeThread({ ...idle }),
          makeThread({ providerInstanceId: CODEX_INSTANCE }),
          makeThread({
            lineage: {
              rootThreadId: ThreadId.make("parent"),
              parentThreadId: ThreadId.make("parent"),
              relationshipToParent: "subagent",
            },
          }),
        ],
        providers: [...claude(99), makeProvider(CODEX_INSTANCE, "codex", [sessionWindow(99)])],
      });
      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("leaves a thread started after the limit was reached running", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [makeThread({ ...idle })],
        laterSweeps: [[makeThread()]],
        providers: claude(91),
      });
      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("does nothing when the pause is turned off", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        threads: [makeThread()],
        providers: claude(99),
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          claudeUsagePause: { ...DEFAULT_SERVER_SETTINGS.claudeUsagePause, enabled: false },
        },
      });
      assert.deepStrictEqual(commands, []);
    }),
  );

  it.effect("interrupts a paused thread when its grace period ends, without another event", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        now: "2026-10-14T09:51:00.000Z",
        threads: [makeThread()],
        providers: claude(95),
        messages: [{ messageId: PAUSE_ID, createdAt: "2026-10-14T09:50:00.000Z" }],
        thenWait: "2 minutes",
      });
      const [interrupt] = commands;
      assert(interrupt?.type === "run.interrupt");
      assert.strictEqual(interrupt.runId, RUN_ID);
    }),
  );

  it.effect("resumes the thread after the window resets, once", () =>
    Effect.gen(function* () {
      const paused = makeThread({ ...idle });
      const due = { now: "2026-10-14T12:03:00.000Z", threads: [paused], providers: claude(95) };
      const pauseRecord = { messageId: PAUSE_ID, createdAt: "2026-10-14T09:50:00.000Z" };
      const commands = yield* runSweep({ ...due, messages: [pauseRecord] });
      const [resume] = commands;
      assert(resume?.type === "message.dispatch");
      assert.strictEqual(resume.messageId, `usage-resume:${PAUSE_ID}`);
      assert.deepStrictEqual(resume.dispatchMode, { type: "start_immediately" });

      const afterResume = yield* runSweep({
        ...due,
        messages: [
          pauseRecord,
          { messageId: `usage-resume:${PAUSE_ID}`, createdAt: "2026-10-14T12:02:30.000Z" },
        ],
      });
      assert.deepStrictEqual(afterResume, []);
    }),
  );

  it.effect("does not resume a thread the user wrote to after the pause", () =>
    Effect.gen(function* () {
      const commands = yield* runSweep({
        now: "2026-10-14T12:03:00.000Z",
        threads: [
          makeThread({
            ...idle,
            latestUserAuthoredMessageAt: iso("2026-10-14T10:30:00.000Z"),
          }),
        ],
        providers: claude(95),
        messages: [{ messageId: PAUSE_ID, createdAt: "2026-10-14T09:50:00.000Z" }],
      });
      assert.deepStrictEqual(commands, []);
    }),
  );
});
