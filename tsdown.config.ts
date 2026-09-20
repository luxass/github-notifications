import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["cjs"],
  outDir: "dist",
  clean: true,
  dts: false,
  platform: "node",
  target: "node26",
  deps: {
    alwaysBundle: [/^effect($|\/)/, /^@effect\//, /^yaml$/],
  },
  outputOptions: {
    // NOTE: tsdown suggests `codeSplitting: false`, but that key does not
    // exist in 0.23.0 and silently keeps the Undici split chunk, which breaks
    // single-file executables.
    inlineDynamicImports: true,
  },
  exe: {
    fileName: "github-notifications",
    targets: [
      { platform: "darwin", arch: "arm64", nodeVersion: "26.9.0" },
      { platform: "linux", arch: "x64", nodeVersion: "26.9.0" },
      { platform: "win", arch: "x64", nodeVersion: "26.9.0" },
    ],
  },
});
