#!/usr/bin/env bun
/**
 * Packs @open-workspace/core and @open-workspace/email from an OpenWorkspace
 * checkout into .core/, where package.json's devDependencies point, for
 * developing against a core that npm doesn't have yet.
 *
 *   bun scripts/pack-core.ts <path to an openworkspace checkout, installed>
 *
 * Once the core release this module needs is on npm, devDependencies take
 * it from there instead and this script can go.
 */
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";

const checkout = process.argv[2];

if (!checkout) throw new Error("Pass the path of an openworkspace checkout");

const out = path.resolve(import.meta.dirname, "..", ".core");

mkdirSync(out, { recursive: true });

for (const name of ["core", "email"]) {
  const result = Bun.spawnSync(
    ["bun", "pm", "pack", "--destination", out, "--quiet"],
    { cwd: path.join(checkout, "packages", name), stderr: "inherit" }
  );

  if (result.exitCode !== 0) throw new Error(`Packing ${name} failed`);

  const tarball = result.stdout.toString().trim();
  renameSync(tarball, path.join(out, `open-workspace-${name}.tgz`));
}
