import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeEnvironmentPresentation } from "~/test/environmentPresentation";
import {
  environmentScopeLabel,
  presentationScopeOptions,
  sidebarEnvironmentScopeOptions,
} from "./environments";

const first = {
  environmentId: EnvironmentId.make("first"),
  label: "Development",
  displayUrl: "https://first.example.com",
};
const second = {
  environmentId: EnvironmentId.make("second"),
  label: "Development",
  displayUrl: "https://second.example.com",
};

describe("environmentScopeLabel", () => {
  it("distinguishes same-name environments by address", () => {
    const environments = [first, second];
    expect(
      environments.map((environment) => environmentScopeLabel(environment, environments)),
    ).toEqual([
      "Development · https://first.example.com",
      "Development · https://second.example.com",
    ]);
  });

  it("falls back to environment IDs when duplicate names have no display URL", () => {
    const environments = [first, second].map((environment) => ({
      ...environment,
      displayUrl: null,
    }));
    expect(
      environments.map((environment) => environmentScopeLabel(environment, environments)),
    ).toEqual(["Development · first", "Development · second"]);
  });

  it("still tells apart two environments that share both name and address", () => {
    const twin = { ...second, displayUrl: first.displayUrl };
    const environments = [first, twin];
    const labels = environments.map((environment) =>
      environmentScopeLabel(environment, environments),
    );
    expect(new Set(labels).size).toBe(2);
    expect(labels[0]).toContain("https://first.example.com");
  });

  it("keeps unique names compact and removes disambiguation after a rename", () => {
    expect(environmentScopeLabel(first, [first])).toBe("Development");
    expect(environmentScopeLabel(first, [first, { ...second, label: "Production" }])).toBe(
      "Development",
    );
  });
});

describe("presentationScopeOptions", () => {
  it("marks every phase but connected offline without dropping the row", () => {
    const options = presentationScopeOptions([
      makeEnvironmentPresentation({ id: "laptop" }),
      makeEnvironmentPresentation({ id: "desk", phase: "reconnecting" }),
    ]);
    expect(options.map((option) => [option.environmentId, option.offline])).toEqual([
      ["laptop", false],
      ["desk", true],
    ]);
  });

  it("disambiguates labels against the whole set it was given", () => {
    const options = presentationScopeOptions([
      makeEnvironmentPresentation({ id: "a", label: "Mac", displayUrl: "https://a.example" }),
      makeEnvironmentPresentation({ id: "b", label: "Mac", displayUrl: "https://b.example" }),
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "Mac · https://a.example",
      "Mac · https://b.example",
    ]);
  });
});

describe("sidebarEnvironmentScopeOptions", () => {
  const desktopServerConfig = {
    environment: { platform: { machine: "desktop" } },
  } as unknown as ServerConfig;

  it("offers only switched-on entries, in catalog order", () => {
    const options = sidebarEnvironmentScopeOptions([
      makeEnvironmentPresentation({ id: "laptop" }),
      makeEnvironmentPresentation({ id: "parked", enabled: false }),
      makeEnvironmentPresentation({ id: "desk" }),
    ]);
    expect(options.map((option) => option.environmentId)).toEqual(["laptop", "desk"]);
  });

  it("offers nothing below two enabled environments, so a single-machine user sees no control", () => {
    expect(
      sidebarEnvironmentScopeOptions([
        makeEnvironmentPresentation({ id: "laptop" }),
        makeEnvironmentPresentation({ id: "parked", enabled: false }),
      ]),
    ).toEqual([]);
  });

  it("carries the machine glyph and offline state, and treats a missing address as none", () => {
    const options = sidebarEnvironmentScopeOptions([
      makeEnvironmentPresentation({ id: "laptop", label: "Mac" }),
      {
        ...makeEnvironmentPresentation({ id: "desk", label: "Mac", phase: "offline" }),
        serverConfig: desktopServerConfig,
      },
    ]);
    expect(options).toEqual([
      { environmentId: "laptop", label: "Mac · laptop", machine: "server", offline: false },
      { environmentId: "desk", label: "Mac · desk", machine: "desktop", offline: true },
    ]);
  });
});
