import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as UsagePauseReactor from "./UsagePauseReactor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const sessionId = "usage-pause-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const threadId = ThreadId.make("thread:usage-pause");
const layerDatabase = SqlitePersistence.layerMemory;

// The external SDK boundary is scripted; the adapter, orchestrator and reactor are real.
const claudeProvider = (usedPercent: number, resetsAt: string): ServerProvider => ({
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: resetsAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: resetsAt,
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
  },
});

const offerText = (offer: SDKUserMessage) => {
  const content = offer.message.content;
  return typeof content === "string"
    ? content
    : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

it.effect("pauses a running Claude thread at the limit and resumes it after the reset", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-usage-pause");
      const offers: SDKUserMessage[] = [];
      let interrupts = 0;
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(sessionId),
          // Each CLI process has its own stream, which ends when the process is closed.
          open: () =>
            Effect.map(Queue.unbounded<SDKMessage>(), (sdkMessages) => ({
              messages: Stream.fromQueue(sdkMessages),
              offer: (message: SDKUserMessage) => Effect.sync(() => void offers.push(message)),
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: () => Effect.void,
              interrupt: Effect.sync(() => void (interrupts += 1)),
              close: Queue.shutdown(sdkMessages),
            })),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const effects = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const resetsAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
        const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
          claudeProvider(40, resetsAt),
        ]);
        const providerChanges = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
        const reportUsage = (usedPercent: number) =>
          Ref.set(providers, [claudeProvider(usedPercent, resetsAt)]).pipe(
            Effect.andThen(Ref.get(providers)),
            Effect.flatMap((current) => PubSub.publish(providerChanges, current)),
          );
        const reactor = yield* UsagePauseReactor.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                dispatch: orchestrator.dispatch,
                getShellSnapshot: orchestrator.getShellSnapshot,
                streamDomainEvents: orchestrator.streamDomainEvents,
              }),
              Layer.mock(ProviderRegistry)({
                getProviders: Ref.get(providers),
                streamChanges: Stream.fromPubSub(providerChanges),
              }),
              ServerSettings.layerTest(),
            ),
          ),
        );
        yield* reactor.start();
        const settle = Effect.gen(function* () {
          yield* effects.drain();
          yield* reactor.drain;
          yield* effects.drain();
        });

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:usage-pause"),
          title: "Usage pause",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Refactor the whole codebase.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* settle;
        yield* Fiber.join(running);
        assert.equal(offers.length, 1);

        yield* reportUsage(92);
        yield* settle;
        const paused = yield* orchestrator.getThreadProjection(threadId);
        const pauseMessage = paused.messages.find((message) =>
          message.id.startsWith("usage-pause:"),
        );
        assert.isDefined(pauseMessage);
        assert.equal(pauseMessage?.createdBy, "agent");
        assert.equal(paused.runs.length, 1, "the pause steers the running turn");
        assert.equal(offers.length, 2);
        assert.include(offerText(offers[1]!), "Paused: Claude 5-hour usage is at 92%");
        assert.equal(offers[1]!.priority, "now");

        yield* TestClock.adjust(Duration.minutes(3));
        yield* settle;
        assert.equal(interrupts, 1, "a run still working after the grace period is interrupted");
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        assert.notInclude(["preparing", "starting", "running", "waiting"], stopped.runs[0]!.status);

        yield* TestClock.adjust(Duration.minutes(60));
        yield* settle;
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.isDefined(
          resumed.messages.find((message) => message.id.startsWith("usage-resume:")),
        );
        assert.equal(resumed.runs.length, 2, "the resume starts a new run");
        assert.include(offerText(offers.at(-1)!), "usage limit has reset");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
            ProviderReplayHarness.layerWithRegistry(
              { name: "claude-usage-pause" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { databaseLayer: layerDatabase, runEffectWorker: false },
            ),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  ),
);
