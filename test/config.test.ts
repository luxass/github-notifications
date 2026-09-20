import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { ConfigParseError, ConfigReadError, loadConfig } from "../src/config.ts";

async function withConfig(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "github-notifications-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, source);
  return path;
}

describe("loadConfig", () => {
  test("loads YAML configuration", async () => {
    const path = await withConfig(`
server:
  host: localhost
  port: 4100
  schedule: "*/5 * * * *"
github:
  tokenEnv: GITHUB_TOKEN
  maxPages: 3
rules:
  - name: mentions
    when: notification.reason == "mention"
    actions:
      - type: read
`);

    await expect(Effect.runPromise(loadConfig(path))).resolves.toMatchObject({
      server: { host: "localhost", port: 4100, schedule: "*/5 * * * *" },
      github: { tokenEnv: "GITHUB_TOKEN", maxPages: 3 },
      rules: [{ name: "mentions", actions: [{ type: "read" }] }],
    });
  });

  test("reports missing files as ConfigReadError", async () => {
    await expect(Effect.runPromise(loadConfig("/missing/config.yaml"))).rejects.toBeInstanceOf(
      ConfigReadError,
    );
  });

  test("reports malformed YAML as ConfigParseError", async () => {
    const path = await withConfig("server: [");

    await expect(Effect.runPromise(loadConfig(path))).rejects.toBeInstanceOf(ConfigParseError);
  });
});
