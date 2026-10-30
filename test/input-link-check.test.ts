import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  checkInputLinks,
  expectedKind,
  formatInputLinkProblems,
  inputLinks,
  isBlockedAddress,
} from "../src/services/input-link-check.js";

let server: Server;
let origin = "";

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const send = (status: number, headers: Record<string, string>) => {
      res.writeHead(status, headers);
      res.end(req.method === "HEAD" ? undefined : "x");
    };
    switch (path) {
      case "/cat.jpg":
        return send(200, { "content-type": "image/jpeg" });
      case "/clip.mp4":
        return send(200, { "content-type": "video/mp4" });
      case "/page":
        return send(200, { "content-type": "text/html; charset=utf-8" });
      case "/private.jpg":
        return send(403, { "content-type": "application/xml" });
      case "/no-head.png":
        // 不接 HEAD 的存储：HEAD 回 405，GET 正常。
        return req.method === "HEAD" ? send(405, {}) : send(206, { "content-type": "image/png" });
      case "/moved":
        return send(302, { location: "/cat.jpg" });
      case "/blob":
        return send(200, { "content-type": "application/octet-stream" });
      default:
        return send(404, { "content-type": "text/plain" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const local = { allowPrivateAddresses: true, timeoutMs: 3000 };

test("working links pass, including a HEAD-less store, a redirect and a generic binary type", async () => {
  const problems = await checkInputLinks(
    {
      prompt: "make it pop https://example.invalid/in-the-prompt-is-not-an-input",
      image: `${origin}/cat.jpg`,
      reference_images: [`${origin}/no-head.png`, `${origin}/moved`],
      video: `${origin}/clip.mp4`,
      last_image: `${origin}/blob`,
    },
    local
  );
  assert.deepEqual(problems, []);
});

test("each unusable link is named with its field and the reason", async () => {
  const problems = await checkInputLinks(
    {
      image: `${origin}/page`,
      images: [`${origin}/cat.jpg`, `${origin}/private.jpg`],
      end_image: `${origin}/gone.jpg`,
      video: `${origin}/cat.jpg`,
    },
    local
  );
  assert.deepEqual(
    problems.map((p) => [p.field, p.url.replace(origin, ""), p.reason]),
    [
      ["image", "/page", "it is a web page (text/html), not a media file"],
      ["images", "/private.jpg", "it is not publicly accessible (HTTP 403)"],
      ["end_image", "/gone.jpg", "the file is not there anymore (HTTP 404)"],
      ["video", "/cat.jpg", "it is an image file, but video needs a video"],
    ]
  );
  const message = formatInputLinkProblems(problems);
  assert.match(message, /^No quote was made and nothing was charged: these input links can't be used\./);
  assert.match(message, /- images: http:\/\/127\.0\.0\.1:\d+\/private\.jpg — it is not publicly accessible \(HTTP 403\)\./);
});

test("private and local addresses are refused without being contacted", async () => {
  // 默认不放行内网：同一个本机假服务，这次一条都不该连上去。
  const problems = await checkInputLinks({
    image: `${origin}/cat.jpg`,
    mask: "http://10.0.0.8/m.png",
    logo: "http://localhost/logo.png",
    avatar: "http://[::1]/a.png",
  });
  assert.equal(problems.length, 4);
  for (const p of problems) assert.equal(p.reason, "it points to a private or local address, which Atlas cannot reach");
});

test("address classification", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.9", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "47.251.103.202", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("field names map to the media kind they expect", () => {
  assert.equal(expectedKind("reference_videos"), "video");
  assert.equal(expectedKind("audio_url"), "audio");
  assert.equal(expectedKind("images.0"), "image");
  assert.equal(expectedKind("source"), undefined);
});

test("links come from every non-text field, deduplicated, at most eight", () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
  const links = inputLinks({ prompt: "https://x.example.com/a.jpg", images: [...many, many[0]], model: "https://m" });
  assert.equal(links.length, 8);
  assert.equal(links[0]!.field, "images");
  assert.ok(!links.some((l) => l.url.startsWith("https://x.example.com")));
});
