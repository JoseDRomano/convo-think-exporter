const esbuild = require("esbuild");

const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  outfile: "dist/extension.js",
};

async function main() {
  const ctx = await esbuild.context(buildOptions);
  if (production) {
    await ctx.rebuild();
    await ctx.dispose();
  } else {
    await ctx.watch();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
