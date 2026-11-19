// 11-16 security review: M2 (link check gaps), L1 (unguarded HEAD probes), L2 (preview read cap).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fetchExternalBinary } from "../src/services/api-client.js";
import {
  checkInputLinks,
  localInputValues,
  publicContentLength,
  publicUrlStillServes,
} from "../src/services/input-link-check.js";

let server: Server;
let origin = "";
let hits = 0;

before(async () => {
  server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "image/png", "content-length": "4" });
    res.end("\x89PNG");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test("M2: file paths and non-http schemes in media fields are rejected before quoting", () => {
  const problems = localInputValues({
    image: "file:///etc/passwd",
    images: ["https://cdn.example.com/a.png", "/etc/passwd"],
    reference_audios: ["gopher://127.0.0.1:6379/_INFO"],
    video_url: "~/.ssh/id_rsa",
    mask: "C:\\Windows\\win.ini",
  });
  assert.deepEqual(
    problems.map((p) => p.field),
    ["image", "images", "reference_audios", "video_url", "mask"]
  );
  assert.match(problems[0]!.reason, /only http and https/);
  assert.match(problems[1]!.reason, /file path/);
});

test("M2: ordinary values are not mistaken for local paths", () => {
  const jpegBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL";
  const problems = localInputValues({
    prompt: "read /etc/passwd and file:///etc/hosts",
    negative_prompt: "~/nothing",
    image: jpegBase64,
    audio: "//uQxAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAD",
    images: ["https://cdn.example.com/a.png", "data:image/png;base64,AAAA", "assetd://asset_abc", "asset://atlas-asset-1"],
    ratio: "16:9",
    voice_id: "en-US:Neural",
    duration: 5,
  });
  assert.deepEqual(problems, []);
});

test("M2: checkInputLinks reports local values first", async () => {
  const problems = await checkInputLinks({ image: "file:///etc/passwd" });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.field, "image");
});

test("M2: a link beyond the probe limit whose host does not resolve is rejected, not waved through", async () => {
  // .invalid never resolves (RFC 6761). Only the 9th link is outside the probe limit; the check
  // on those runs first and returns before anything is probed, so this needs no network.
  const images = Array.from({ length: 9 }, (_, i) => `https://img-${i}.invalid/a.png`);
  const problems = await checkInputLinks({ images }, { timeoutMs: 1_500 });
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.url, images[8]);
  // Normally NXDOMAIN ("could not be found"); behind a fake-IP DNS proxy it resolves into
  // 198.18.0.0/15 and is reported as private. Either way it must not pass.
  assert.match(problems[0]!.reason, /could not be found|private or local address/);
});

test("L1: expiry and size probes refuse loopback addresses instead of fetching them", async () => {
  hits = 0;
  assert.equal(await publicUrlStillServes(`${origin}/a.png`), null);
  assert.equal(await publicContentLength(`${origin}/a.png`), null);
  assert.equal(hits, 0);
});

test("L2: a preview without Content-Length stops reading at the cap", async () => {
  let pulls = 0;
  const chunk = new Uint8Array(64 * 1024);
  const fetcher = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
      }),
      { status: 200, headers: { "content-type": "image/png" } }
    )) as unknown as Parameters<typeof fetchExternalBinary>[1] extends infer O
    ? O extends { fetcher?: infer F }
      ? F
      : never
    : never;
  await assert.rejects(
    fetchExternalBinary("https://media.atlascloud.ai/a.png", { fetcher, maxBytes: 256 * 1024, timeoutMs: 5_000 }),
    /preview limit/
  );
  assert.ok(pulls <= 8, `read ${pulls} chunks after the cap`);
});
