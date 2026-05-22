import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, "../.tmp/title-metadata.test.cjs");

mkdirSync(dirname(outputPath), { recursive: true });

await esbuild.build({
  bundle: true,
  entryPoints: [resolve(__dirname, "title-metadata.test.ts")],
  format: "cjs",
  logLevel: "silent",
  outfile: outputPath,
  platform: "node",
  plugins: [
    {
      name: "obsidian-test-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({
          namespace: "obsidian-test-stub",
          path: "obsidian",
        }));
        build.onLoad(
          { filter: /.*/, namespace: "obsidian-test-stub" },
          () => ({
            contents: `
              class Modal {}
              class Plugin {}
              class PluginSettingTab {}
              class Setting {}
              class TAbstractFile {}
              class TFile extends TAbstractFile {}
              const normalizePath = (path) => path.replace(/\\\\/g, "/").replace(/\\/+/g, "/");
              const Notice = class {};
              module.exports = {
                Modal,
                Notice,
                Plugin,
                PluginSettingTab,
                Setting,
                TAbstractFile,
                TFile,
                normalizePath,
              };
            `,
            loader: "js",
          }),
        );
      },
    },
  ],
  target: "node22",
});

const result = spawnSync(process.execPath, ["--test", outputPath], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
