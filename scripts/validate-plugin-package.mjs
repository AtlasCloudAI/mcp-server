#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const packageDir = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "usage: node scripts/validate-plugin-package.mjs <package-directory>");

async function filesUnder(root) {
  const files = [];
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(path, entry.name);
      const metadata = await lstat(fullPath);
      assert.equal(metadata.isSymbolicLink(), false, `symbolic link is not allowed: ${relative(root, fullPath)}`);
      if (metadata.isDirectory()) await visit(fullPath);
      else if (metadata.isFile()) files.push(fullPath);
    }
  }
  await visit(root);
  return files.sort();
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fetchSchema(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `schema fetch failed: ${url} returned ${response.status}`);
  return response.json();
}

const metadata = await lstat(packageDir);
assert.equal(metadata.isDirectory(), true, "package path must be a directory");
const allFiles = await filesUnder(packageDir);
assert.ok(allFiles.length > 0, "package is empty");

const forbiddenNames = allFiles.filter((path) => {
  const parts = path.split(sep);
  const name = parts.at(-1) ?? "";
  return (
    [".DS_Store", ".env", "Thumbs.db"].includes(name) ||
    parts.includes("__pycache__") ||
    /\.py[co]$/i.test(name)
  );
});
assert.deepEqual(forbiddenNames, [], "package contains hidden or environment files");

const pluginPath = join(packageDir, "plugin.json");
const mcpPath = join(packageDir, "mcp.json");
const plugin = await json(pluginPath);
const mcp = await json(mcpPath);
const [pluginSchema, mcpSchema] = await Promise.all([
  fetchSchema("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
  fetchSchema("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"),
]);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const [name, schema, value] of [
  ["plugin.json", pluginSchema, plugin],
  ["mcp.json", mcpSchema, mcp],
]) {
  const validate = ajv.compile(schema);
  assert.equal(validate(value), true, `${name} schema errors: ${ajv.errorsText(validate.errors)}`);
}

assert.equal(plugin.version, "0.3.3");
const serverEntries = Object.entries(mcp.mcpServers ?? {});
assert.equal(serverEntries.length, 1, "mcp.json must expose exactly one server");
const [, server] = serverEntries[0];
assert.equal(server.type, "streamable-http");
const serverUrl = new URL(server.url);
assert.equal(serverUrl.protocol, "https:");
assert.equal(serverUrl.pathname, "/mcp");
assert.equal(serverUrl.username, "");
assert.equal(serverUrl.password, "");
assert.equal(serverUrl.search, "");
assert.equal(serverUrl.hash, "");
assert.equal("headers" in server, false, "mcp.json must not embed visible authorization headers");

const skillsDir = join(packageDir, "skills");
const skillEntries = (await readdir(skillsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(skillEntries, [
  "atlas-cloud",
  "seedance-2-5-skill",
  "universal-video-prompt-skill",
]);
for (const skill of skillEntries) {
  const skillFile = join(skillsDir, skill, "SKILL.md");
  assert.equal((await lstat(skillFile)).isFile(), true, `${skill} has no SKILL.md`);
}

let markdownLinkCount = 0;
const missingLinks = [];
for (const path of allFiles.filter((candidate) => candidate.endsWith(".md"))) {
  const content = await readFile(path, "utf8");
  const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<")) {
      const close = target.indexOf(">");
      target = close >= 0 ? target.slice(1, close) : target;
    } else {
      target = target.split(/\s+/, 1)[0];
    }
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    markdownLinkCount += 1;
    const withoutAnchor = target.split("#", 1)[0];
    const decoded = decodeURIComponent(withoutAnchor);
    const destination = resolve(dirname(path), decoded);
    const packagePrefix = packageDir.endsWith(sep) ? packageDir : `${packageDir}${sep}`;
    if (!destination.startsWith(packagePrefix)) {
      missingLinks.push(`${relative(packageDir, path)} -> ${target} (escapes package)`);
      continue;
    }
    try {
      await lstat(destination);
    } catch {
      missingLinks.push(`${relative(packageDir, path)} -> ${target}`);
    }
  }
}
assert.deepEqual(missingLinks, [], `missing relative Markdown links:\n${missingLinks.join("\n")}`);

const testCases = await readFile(join(packageDir, "TEST_CASES.md"), "utf8");
assert.equal((testCases.match(/^## Positive \d+\b/gm) ?? []).length, 12);
assert.equal((testCases.match(/^## Negative \d+\b/gm) ?? []).length, 6);

const sensitivePatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bcli_[A-Za-z0-9]{16,}\b/,
  /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{16,}/i,
];
const sensitiveAssignment =
  /(?:LARK_APP_SECRET|ATLASCLOUD_API_KEY|REDIS_PASSWORD)\s*[=:]\s*['"]?([A-Za-z0-9._~-]{16,})/g;
const sensitiveFiles = [];
for (const path of allFiles) {
  const metadataForFile = await lstat(path);
  if (metadataForFile.size > 2 * 1024 * 1024) continue;
  const content = await readFile(path, "utf8").catch(() => "");
  const hasSensitiveAssignment = [...content.matchAll(sensitiveAssignment)].some((match) =>
    !/(?:your|example|placeholder|replace|dummy|test)/i.test(match[1])
  );
  if (sensitivePatterns.some((pattern) => pattern.test(content)) || hasSensitiveAssignment) {
    sensitiveFiles.push(relative(packageDir, path));
  }
}
assert.deepEqual(sensitiveFiles, [], `potential secret material: ${sensitiveFiles.join(", ")}`);

const deploymentEvidence = await readFile(
  join(packageDir, "DEPLOYMENT_EVIDENCE.md"),
  "utf8"
).catch(() =>
  readFile(join(packageDir, "..", "internal", "DEPLOYMENT_EVIDENCE.md"), "utf8")
);
const completedEvidence = (deploymentEvidence.match(/^- \[x\]/gm) ?? []).length;
const pendingEvidence = (deploymentEvidence.match(/^- \[ \]/gm) ?? []).length;

process.stdout.write(
  [
    "PLUGIN_PACKAGE_VALID",
    `files=${allFiles.length}`,
    `skills=${skillEntries.length}`,
    `relative_markdown_links=${markdownLinkCount}`,
    `deployment_checks_complete=${completedEvidence}`,
    `deployment_checks_pending=${pendingEvidence}`,
  ].join(" ") + "\n"
);
