import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { makeContinuingServerSelfUpdate } from "./continuingSelfUpdate.ts";

export const serverUpdateHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "server",
  Effect.fnUntraced(function* (handlers) {
    const selfUpdate = yield* makeContinuingServerSelfUpdate;
    return handlers.handle(
      "update",
      Effect.fn("environment.server.update")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        return yield* selfUpdate
          .update(args.payload)
          .pipe(Effect.catch((error) => failEnvironmentInternal("server_update_failed", error)));
      }),
    );
  }),
);
