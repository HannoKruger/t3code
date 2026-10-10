import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { createBuildConfig } from "./build-desktop-artifact.ts";

const withEnvironment = (env: Record<string, string>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const createMacBuildConfig = (signed: boolean) =>
  createBuildConfig("mac", "dmg", "0.0.46-hanno.1", signed, false, undefined, undefined);

it.layer(NodeServices.layer)("self-signed macOS builds", (it) => {
  it.effect("signs with the configured identity without hardened runtime or notarization", () =>
    Effect.gen(function* () {
      const config = yield* createMacBuildConfig(false);

      const mac = config.mac as Record<string, unknown>;
      assert.equal(mac.identity, "Hanno Kruger T3 Code");
      assert.equal(mac.hardenedRuntime, false);
      assert.equal(mac.notarize, false);
      assert.match(String(mac.sign), /[\\/]scripts[\\/]sign-macos\.ts$/);
    }).pipe(withEnvironment({ T3CODE_DESKTOP_MAC_SELF_SIGNED_IDENTITY: " Hanno Kruger T3 Code " })),
  );

  it.effect("leaves unsigned builds unchanged without an identity", () =>
    Effect.gen(function* () {
      const config = yield* createMacBuildConfig(false);

      const mac = config.mac as Record<string, unknown>;
      assert.isUndefined(mac.identity);
      assert.isUndefined(mac.hardenedRuntime);
      assert.isUndefined(mac.sign);
    }).pipe(withEnvironment({})),
  );

  it.effect("ignores the identity for Developer ID signed builds", () =>
    Effect.gen(function* () {
      const config = yield* createMacBuildConfig(true);

      const mac = config.mac as Record<string, unknown>;
      assert.isUndefined(mac.identity);
      assert.isUndefined(mac.hardenedRuntime);
    }).pipe(withEnvironment({ T3CODE_DESKTOP_MAC_SELF_SIGNED_IDENTITY: "Hanno Kruger T3 Code" })),
  );
});
