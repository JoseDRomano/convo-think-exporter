import { defineConfig } from "@vscode/test-cli";

export default defineConfig([
  {
    files: "out/test/**/*.test.js",
    label: "Convo Think Export Tests",
  },
]);
