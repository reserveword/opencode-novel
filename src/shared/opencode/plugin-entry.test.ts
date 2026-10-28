import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { withTempDir } from "../../../test/utils";
import {
  GENERATED_SHIM_HEADER,
  isGeneratedPluginShim,
  removeGeneratedPluginShim,
  renderPluginShim,
  resolvePluginInstallPaths,
  updatePluginConfig,
} from "./plugin-entry";

describe("plugin-entry", () => {
  it("renders an ESM shim that is recognized as generated", () => {
    const shim = renderPluginShim(path.join("pkg", "dist", "index.js"));

    expect(shim.startsWith(GENERATED_SHIM_HEADER)).toBeTrue();
    expect(shim).toContain("export { default } from");
    expect(isGeneratedPluginShim(shim)).toBeTrue();
    expect(isGeneratedPluginShim("export default {}")).toBeFalse();
  });

  it("removes legacy and explicit plugin entries while preserving unrelated ones", async () => {
    await withTempDir((rootDir) => {
      const installRoot = path.join(rootDir, ".opencode");
      const paths = resolvePluginInstallPaths(installRoot);
      const configPath = path.join(installRoot, "opencode.json");
      const keepOne = "file:///C:/other/keep.js";
      const keepTwo = "file:///C:/other/keep2.js";
      mkdirSync(installRoot, { recursive: true });
      writeFileSync(
        configPath,
        `{
  // keep this comment
  "$schema": "https://opencode.ai/config.json",
  "plugin": [${JSON.stringify(pathToFileURL(paths.legacyEntryPath).toString())}, ${JSON.stringify(keepOne)}],
  "plugins": [
    ${JSON.stringify(pathToFileURL(paths.entryPath).toString())},
    ${JSON.stringify(paths.pluginDir)},
    { "package": "some-npm-plugin", "options": { "a": 1 } },
    ${JSON.stringify(keepTwo)}
  ]
}
`,
        "utf8",
      );

      const result = updatePluginConfig({ configPath, paths });
      const text = readFileSync(configPath, "utf8");
      const data = parse(text) as Record<string, unknown>;

      expect(result.changed).toBeTrue();
      expect(result.removed).toHaveLength(3);
      expect(data.plugin).toEqual([keepOne]);
      expect(data.plugins).toEqual([{ package: "some-npm-plugin", options: { a: 1 } }, keepTwo]);
      expect(text).toContain("// keep this comment");
    });
  });

  it("does not write when the update is a dry run", async () => {
    await withTempDir((rootDir) => {
      const installRoot = path.join(rootDir, ".opencode");
      const paths = resolvePluginInstallPaths(installRoot);
      const configPath = path.join(installRoot, "opencode.json");
      const original = `{\n  "plugins": [${JSON.stringify(pathToFileURL(paths.entryPath).toString())}]\n}\n`;
      mkdirSync(installRoot, { recursive: true });
      writeFileSync(configPath, original, "utf8");

      const result = updatePluginConfig({ configPath, paths, dryRun: true });

      expect(result.changed).toBeTrue();
      expect(readFileSync(configPath, "utf8")).toBe(original);
    });
  });

  it("deletes a plugin field when every entry is removed", async () => {
    await withTempDir((rootDir) => {
      const installRoot = path.join(rootDir, ".opencode");
      const paths = resolvePluginInstallPaths(installRoot);
      const configPath = path.join(installRoot, "opencode.json");
      mkdirSync(installRoot, { recursive: true });
      writeFileSync(
        configPath,
        `{\n  "plugin": [${JSON.stringify(pathToFileURL(paths.legacyEntryPath).toString())}]\n}\n`,
        "utf8",
      );

      updatePluginConfig({ configPath, paths });
      const data = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

      expect(Object.hasOwn(data, "plugin")).toBeFalse();
    });
  });

  it("only removes generated shims unless forced", async () => {
    await withTempDir((rootDir) => {
      const shimPath = path.join(rootDir, "plugins", "opencode-novel", "index.js");
      mkdirSync(path.dirname(shimPath), { recursive: true });
      writeFileSync(shimPath, renderPluginShim(path.join(rootDir, "dist", "index.js")), "utf8");

      expect(
        removeGeneratedPluginShim(shimPath, { dryRun: true, force: false }).removed,
      ).toBeTrue();
      expect(existsSync(shimPath)).toBeTrue();

      writeFileSync(shimPath, "// hand edited\nexport default {};\n", "utf8");
      const skipped = removeGeneratedPluginShim(shimPath, { dryRun: false, force: false });
      expect(skipped.skipped).toBeTrue();
      expect(skipped.reason).toContain("modified");
      expect(existsSync(shimPath)).toBeTrue();

      expect(
        removeGeneratedPluginShim(shimPath, { dryRun: false, force: true }).removed,
      ).toBeTrue();
      expect(existsSync(shimPath)).toBeFalse();
    });
  });
});
