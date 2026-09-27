import { build, context } from "esbuild";

const options = { entryPoints: ["frontend/markdown/index.js"], outfile: "public/assets/markdown-renderer.js",
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "eof" };
if (process.argv.includes("--watch")) await (await context(options)).watch();
else await build(options);
