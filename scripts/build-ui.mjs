#!/usr/bin/env node
// 把 ui/generation-card 打成一个自包含的 HTML：dist/ui/generation-card.html。
// 宿主在沙箱 iframe 里加载它，所以脚本、样式全部内联，不引用任何外部文件。
// 在 `npm run build` 里 tsc 之后运行；src/apps/generation-card.ts 读这个文件作为卡片资源。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "ui", "generation-card");
const outFile = join(root, "dist", "ui", "generation-card.html");

const bundled = await build({
  entryPoints: [join(source, "main.ts")],
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "browser",
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "warning",
});

// 内联到 <script> 里：打包结果中出现 "</script" 会提前结束标签，转义掉。
const script = bundled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = readFileSync(join(source, "styles.css"), "utf8");
const template = readFileSync(join(source, "index.html"), "utf8");

const html = template
  .replace("<!--STYLE-->", () => `<style>${css}</style>`)
  .replace("<!--SCRIPT-->", () => `<script type="module">${script}</script>`);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`ui: ${outFile.slice(root.length + 1)} (${(html.length / 1024).toFixed(1)} KB)`);
