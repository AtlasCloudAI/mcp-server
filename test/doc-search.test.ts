import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bestSnippet,
  parseDocIndex,
  queryTerms,
  resetDocSearchCacheForTests,
  searchDocs,
} from "../src/services/doc-search.ts";

const BASE = "https://www.atlascloud.ai/docs/llms.txt";

const INDEX = `# Atlas Cloud

> Atlas Cloud is an AI API aggregation platform.

## Documentation

- [Overview](https://www.atlascloud.ai/docs/.md): Atlas Cloud - AI API Aggregation Platform
- [Upload Files](https://www.atlascloud.ai/docs/upload-files.md): Upload local files to Atlas Cloud for image-to-video, image editing, and other workflows
- [Refunds & Failed Tasks](https://www.atlascloud.ai/docs/billing/refunds.md): Refund policy, automatic handling of failed generations, and billing disputes
- [Webhooks](https://www.atlascloud.ai/docs/webhooks.md): Get notified the moment an async generation task finishes
- [Elsewhere](https://evil.example.com/docs/x.md): not ours

## Optional

- [Model Library](https://www.atlascloud.ai/models): The always-current catalog.
`;

const BODIES: Record<string, string> = {
  "https://www.atlascloud.ai/docs/en.md": "# Overview\n\nAtlas Cloud gives one API key for 400+ models.",
  "https://www.atlascloud.ai/docs/upload-files.md":
    "# Upload Files\n\nUpload local files to Atlas Cloud for image-to-video, image editing, and other workflows\n\nSource: https://atlascloud.ai/docs/en/upload-files\n\n" +
    "## Upload a local file\n\nCall POST /api/v1/model/uploadMedia with the file. The response gives a temporary URL you pass to image-to-video.",
  "https://www.atlascloud.ai/docs/billing/refunds.md":
    "# Refunds & Failed Tasks\n\nIf a generation task fails, the reserved amount is returned to your balance automatically.",
  "https://www.atlascloud.ai/docs/webhooks.md": "# Webhooks\n\nSupply a webhook_url when you submit the task.",
};

function fakeFetch(options: { failing?: Set<string>; delayMs?: number; calls?: string[]; indexDown?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    options.calls?.push(url);
    if (options.delayMs && url !== BASE) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (url === BASE) {
      if (options.indexDown) return new Response("down", { status: 503 });
      return new Response(INDEX, { status: 200 });
    }
    if (options.failing?.has(url) || !(url in BODIES)) return new Response("nope", { status: 404 });
    return new Response(BODIES[url], { status: 200 });
  }) as typeof fetch;
}

afterEach(() => resetDocSearchCacheForTests());

describe("doc search", () => {
  it("parses only our /docs pages and maps the broken overview link", () => {
    const pages = parseDocIndex(INDEX, new URL(BASE));
    assert.deepEqual(
      pages.map((page) => page.markdownUrl),
      [
        "https://www.atlascloud.ai/docs/en.md",
        "https://www.atlascloud.ai/docs/upload-files.md",
        "https://www.atlascloud.ai/docs/billing/refunds.md",
        "https://www.atlascloud.ai/docs/webhooks.md",
      ]
    );
    assert.equal(pages[0].url, "https://www.atlascloud.ai/docs");
    assert.equal(pages[1].url, "https://www.atlascloud.ai/docs/upload-files", "the link shown to users is the page, not the .md");
  });

  it("drops filler words from the query", () => {
    assert.deepEqual(queryTerms("How do I upload a file to Atlas Cloud?"), ["upload", "file"]);
    assert.deepEqual(queryTerms("怎么上传文件"), [], "the docs are English; the tool description asks for English keywords");
  });

  it("ranks the page that answers the question first and quotes the passage", async () => {
    const hits = await searchDocs("how to upload a file", { fetcher: fakeFetch() });
    assert.equal(hits[0].title, "Upload Files");
    assert.equal(hits[0].url, "https://www.atlascloud.ai/docs/upload-files");
    assert.match(hits[0].snippet, /uploadMedia/);

    const refunds = await searchDocs("refund for a failed task", { fetcher: fakeFetch() });
    assert.equal(refunds[0].title, "Refunds & Failed Tasks");
    assert.match(refunds[0].snippet, /returned to your balance/);
  });

  it("returns nothing for a query with no matches", async () => {
    assert.deepEqual(await searchDocs("kubernetes helm chart", { fetcher: fakeFetch() }), []);
  });

  it("does not refetch a page that just failed on every search", async () => {
    const calls: string[] = [];
    const failing = new Set(["https://www.atlascloud.ai/docs/webhooks.md"]);
    const now = Date.parse("2026-11-11T08:00:00Z");
    await searchDocs("webhook", { fetcher: fakeFetch({ failing, calls }), now });
    await searchDocs("webhook", { fetcher: fakeFetch({ failing, calls }), now: now + 60_000 });
    assert.equal(calls.filter((url) => url.endsWith("/webhooks.md")).length, 1);

    // 十分钟后再试一次。
    await searchDocs("webhook", { fetcher: fakeFetch({ failing, calls }), now: now + 11 * 60_000 });
    assert.equal(calls.filter((url) => url.endsWith("/webhooks.md")).length, 2);
  });

  it("still finds a page by title when its body cannot be read", async () => {
    const failing = new Set(["https://www.atlascloud.ai/docs/webhooks.md"]);
    const hits = await searchDocs("webhooks", { fetcher: fakeFetch({ failing }) });
    assert.equal(hits[0].title, "Webhooks");
    assert.equal(hits[0].snippet, "");
  });

  it("keeps serving the cached index when the site is down", async () => {
    const now = Date.parse("2026-11-11T08:00:00Z");
    await searchDocs("upload file", { fetcher: fakeFetch(), now });
    const hits = await searchDocs("upload file", { fetcher: fakeFetch({ indexDown: true }), now: now + 2 * 60 * 60_000 });
    assert.equal(hits[0].title, "Upload Files");
  });

  it("fails when there is no index at all", async () => {
    await assert.rejects(searchDocs("upload file", { fetcher: fakeFetch({ indexDown: true }) }));
  });

  it("answers from titles when page bodies are slow, then uses them once loaded", async () => {
    const fetcher = fakeFetch({ delayMs: 200 });
    const first = await searchDocs("upload file", { fetcher, waitMs: 20 });
    assert.equal(first[0].title, "Upload Files");
    assert.equal(first[0].snippet, "", "bodies were still loading");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await searchDocs("upload file", { fetcher, waitMs: 20 });
    assert.match(second[0].snippet, /uploadMedia/);
  });

  it("picks the block with the most query words, not a Source line", () => {
    const body = "Source: https://atlascloud.ai/docs/en/x\n\nUnrelated intro text here.\n\nRefunds are automatic when a task fails.";
    assert.equal(bestSnippet(body, ["refund", "fail"]), "Refunds are automatic when a task fails.");
  });
});
