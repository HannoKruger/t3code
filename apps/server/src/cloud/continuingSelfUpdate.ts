import { ServerSelfUpdateError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

/** The server update every transport offers: provider turns running at the handoff continue in the new version. */
export const makeContinuingServerSelfUpdate = Effect.gen(function* () {
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const config = yield* ServerConfig.ServerConfig;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  return yield* ServerSelfUpdate.withRunningThreadContinuation({
    mode: config.mode,
    selfUpdate,
    prepare: startup.markRunningProviderSessionsForContinuation.pipe(
      Effect.mapError(
        (cause) =>
          new ServerSelfUpdateError({
            reason: "Could not prepare running threads to continue after the update.",
            cause,
          }),
      ),
    ),
    clear: (threadIds) =>
      startup.clearProviderSessionContinuationMarkers(threadIds).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSelfUpdateError({
              reason: "Could not clear thread continuation markers after the update failed.",
              cause,
            }),
        ),
      ),
  });
});
