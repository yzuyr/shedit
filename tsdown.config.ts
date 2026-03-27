import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/plugins/twoslash-hover.ts"],
  platform: "browser",
  dts: true,
});
