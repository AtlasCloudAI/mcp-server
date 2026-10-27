import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  chatFileHostsFromEnv,
  importChatFiles,
  isAllowedChatFileHost,
  resolveChatFileName,
  sniffExtension,
  type ChatFileImportOptions,
  type DownloadFetcher,
} from "../src/services/chat-file-import.js";
import { registerImportChatFilesTool } from "../src/tools/import-chat-files.js";

const ATTACHMENT = "https://files.oaiusercontent.com/file-abc?se=2026-10-27&sig=x";
const STORED = "https://atlas-img.oss-accelerate-overseas.aliyuncs.com/images/stored.png";

type UploadFetcher = NonNullable<ChatFileImportOptions["uploadFetcher"]>;

/** 假的附件下载：按地址返回字节、跳转或错误，并记下请求过哪些地址。 */
function fakeDownload(
  routes: Record<string, () => Response>
): DownloadFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (url: URL) => {
    calls.push(url.toString());
    const route = routes[url.toString()];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  }) as DownloadFetcher & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}

/** 假的 Atlas 上传：记下收到的文件名和字节数，回一个公网地址。 */
function fakeUpload(): UploadFetcher & { received: Array<{ name: string; size: number }> } {
  const received: Array<{ name: string; size: number }> = [];
  const fetcher = (async (_url: unknown, init: { body: FormData }) => {
    const file = init.body.get("file") as File;
    received.push({ name: file.name, size: file.size });
    return new Response(
      JSON.stringify({
        code: 200,
        message: "ok",
        data: { type: "image", download_url: STORED, filename: file.name, size: file.size },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as UploadFetcher & { received: Array<{ name: string; size: number }> };
  fetcher.received = received;
  return fetcher;
}

const png = () =>
  new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), {
    status: 200,
    headers: { "content-type": "image/png", "content-length": "7" },
  });

function options(overrides: Partial<ChatFileImportOptions> = {}): ChatFileImportOptions {
  return {
    apiKey: "user-key",
    maxBytes: 1024,
    allowedHosts: ["oaiusercontent.com"],
    ...overrides,
  };
}

test("附件下载后转存，文件名保留原名和扩展名", async () => {
  const download = fakeDownload({ [ATTACHMENT]: png });
  const upload = fakeUpload();
  const result = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "file_1", file_name: "sneaker.png", mime_type: "image/png" }],
    options({ downloadFetcher: download, uploadFetcher: upload })
  );
  assert.deepEqual(result.failed, []);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]!.url, STORED);
  assert.equal(result.imported[0]!.media_type, "image");
  assert.deepEqual(upload.received, [{ name: "sneaker.png", size: 7 }]);
});

test("没给名字和类型时，按下载响应的 Content-Type 补扩展名", async () => {
  const download = fakeDownload({ [ATTACHMENT]: png });
  const upload = fakeUpload();
  const result = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "file_2" }],
    options({ downloadFetcher: download, uploadFetcher: upload })
  );
  assert.equal(result.imported[0]!.file_name, "file_2.png");
  assert.deepEqual(upload.received.map((r) => r.name), ["file_2.png"]);
});

test("不是聊天附件的域名一律不下载", async () => {
  const download = fakeDownload({});
  const upload = fakeUpload();
  const result = await importChatFiles(
    [
      { download_url: "https://169.254.169.254/latest/meta-data", file_id: "a" },
      { download_url: "http://files.oaiusercontent.com/x.png", file_id: "b" },
      { download_url: "https://user:pw@files.oaiusercontent.com/x.png", file_id: "c" },
      { download_url: "https://files.oaiusercontent.com:8443/x.png", file_id: "d" },
      { download_url: "https://evil-oaiusercontent.com/x.png", file_id: "e" },
    ],
    options({ downloadFetcher: download, uploadFetcher: upload })
  );
  assert.equal(result.imported.length, 0);
  assert.equal(result.failed.length, 5);
  assert.deepEqual(download.calls, []);
  assert.deepEqual(upload.received, []);
  assert.match(result.failed[0]!.reason, /not a chat attachment/);
});

test("跳转到名单外的域名会被拦下", async () => {
  const download = fakeDownload({
    [ATTACHMENT]: () =>
      new Response(null, { status: 302, headers: { location: "https://example.com/x.png" } }),
  });
  const result = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "file_3", file_name: "x.png" }],
    options({ downloadFetcher: download, uploadFetcher: fakeUpload() })
  );
  assert.equal(result.imported.length, 0);
  assert.match(result.failed[0]!.reason, /not a chat attachment/);
  assert.deepEqual(download.calls, [ATTACHMENT]);
});

test("名单内的跳转照常跟", async () => {
  const cdn = "https://cdn.oaiusercontent.com/blob/x";
  const download = fakeDownload({
    [ATTACHMENT]: () => new Response(null, { status: 302, headers: { location: cdn } }),
    [cdn]: png,
  });
  const result = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "file_4", file_name: "x.png" }],
    options({ downloadFetcher: download, uploadFetcher: fakeUpload() })
  );
  assert.equal(result.imported.length, 1);
  assert.deepEqual(download.calls, [ATTACHMENT, cdn]);
});

test("超过大小上限：声明的长度超了不读，边读边超也会停", async () => {
  const declaredTooBig = fakeDownload({
    [ATTACHMENT]: () =>
      new Response("x", { status: 200, headers: { "content-type": "image/png", "content-length": "5000" } }),
  });
  const r1 = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "big", file_name: "big.png" }],
    options({ downloadFetcher: declaredTooBig, uploadFetcher: fakeUpload() })
  );
  assert.match(r1.failed[0]!.reason, /larger than the 1 KB limit/);

  const streamedTooBig = fakeDownload({
    [ATTACHMENT]: () =>
      new Response(new Uint8Array(4096), { status: 200, headers: { "content-type": "image/png" } }),
  });
  const r2 = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "big2", file_name: "big2.png" }],
    options({ downloadFetcher: streamedTooBig, uploadFetcher: fakeUpload() })
  );
  assert.match(r2.failed[0]!.reason, /larger than/);
});

test("声明是 PDF 的文件不下载，直接说明只收图片视频音频", async () => {
  const download = fakeDownload({ [ATTACHMENT]: png });
  const result = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "doc", file_name: "brief.pdf", mime_type: "application/pdf" }],
    options({ downloadFetcher: download, uploadFetcher: fakeUpload() })
  );
  assert.match(result.failed[0]!.reason, /Only images, videos and audio/);
  assert.deepEqual(download.calls, []);
});

test("附件链接过期（403/404/410）时让用户重新附上", async () => {
  const download = fakeDownload({ [ATTACHMENT]: () => new Response("gone", { status: 403 }) });
  const result = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "old", file_name: "old.png" }],
    options({ downloadFetcher: download, uploadFetcher: fakeUpload() })
  );
  assert.match(result.failed[0]!.reason, /expired/);
});

test("一个失败不影响其他文件", async () => {
  const ok = "https://files.oaiusercontent.com/ok";
  const bad = "https://files.oaiusercontent.com/bad";
  const download = fakeDownload({ [ok]: png, [bad]: () => new Response("no", { status: 500 }) });
  const result = await importChatFiles(
    [
      { download_url: bad, file_id: "bad", file_name: "bad.png" },
      { download_url: ok, file_id: "ok", file_name: "ok.png" },
    ],
    options({ downloadFetcher: download, uploadFetcher: fakeUpload() })
  );
  assert.deepEqual(result.imported.map((f) => f.file_id), ["ok"]);
  assert.deepEqual(result.failed.map((f) => f.file_id), ["bad"]);
});

test("文件名和类型的推断", () => {
  assert.deepEqual(resolveChatFileName({ file_id: "f", file_name: "a.JPG" }), {
    fileName: "a.JPG",
    mediaType: "image",
  });
  assert.deepEqual(resolveChatFileName({ file_id: "f", file_name: "clip", mime_type: "video/quicktime" }), {
    fileName: "clip.mov",
    mediaType: "video",
  });
  assert.deepEqual(resolveChatFileName({ file_id: "f", file_name: "../../etc/voice.m4a" }), {
    fileName: "voice.m4a",
    mediaType: "audio",
  });
  assert.throws(() => resolveChatFileName({ file_id: "f", file_name: "notes.txt" }), /Only images/);
});

test("webm 按 MIME 区分音频和视频", () => {
  assert.equal(resolveChatFileName({ file_id: "f", file_name: "memo.webm", mime_type: "audio/webm" }).mediaType, "audio");
  assert.equal(resolveChatFileName({ file_id: "f", file_name: "clip.webm", mime_type: "video/webm" }).mediaType, "video");
});

/** 补齐到 16 字节，够文件头识别用。 */
function header(...parts: Array<number[] | string>): Uint8Array {
  const bytes = parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part));
  while (bytes.length < 16) bytes.push(0);
  return new Uint8Array(bytes);
}

test("按文件头识别常见格式", () => {
  assert.equal(sniffExtension(header([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(sniffExtension(header([0x89], "PNG")), "png");
  assert.equal(sniffExtension(header("RIFF", [0, 0, 0, 0], "WEBP")), "webp");
  assert.equal(sniffExtension(header("RIFF", [0, 0, 0, 0], "WAVE")), "wav");
  assert.equal(sniffExtension(header([0, 0, 0, 0x18], "ftypisom")), "mp4");
  assert.equal(sniffExtension(header([0, 0, 0, 0x14], "ftypqt  ")), "mov");
  assert.equal(sniffExtension(header([0, 0, 0, 0x18], "ftypheic")), "heic");
  assert.equal(sniffExtension(header("ID3")), "mp3");
  assert.equal(sniffExtension(header("%PDF-1.7")), undefined);
  assert.equal(sniffExtension(new Uint8Array([0xff, 0xd8])), undefined);
});

test("宿主只给 octet-stream 时照样下载，按文件头认出图片", async () => {
  const jpeg = header([0xff, 0xd8, 0xff, 0xe0]);
  const download = fakeDownload({
    [ATTACHMENT]: () =>
      new Response(jpeg, { status: 200, headers: { "content-type": "application/octet-stream" } }),
  });
  const upload = fakeUpload();
  const result = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "file_9", mime_type: "application/octet-stream" }],
    options({ downloadFetcher: download, uploadFetcher: upload })
  );
  assert.deepEqual(result.failed, []);
  assert.equal(result.imported[0]!.file_name, "file_9.jpg");
  assert.equal(result.imported[0]!.media_type, "image");
});

test("HEIC 照片不转存，提示换成 JPEG/PNG；声明了就不下载，没声明也按文件头拦", async () => {
  const heic = header([0, 0, 0, 0x18], "ftypheic");
  const download = fakeDownload({
    [ATTACHMENT]: () => new Response(heic, { status: 200, headers: { "content-type": "application/octet-stream" } }),
  });
  const upload = fakeUpload();
  const declared = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "file_h1", file_name: "IMG_0001.HEIC" }],
    options({ downloadFetcher: download, uploadFetcher: upload })
  );
  assert.match(declared.failed[0]!.reason, /HEIC\/HEIF.*JPEG or PNG/);
  assert.deepEqual(download.calls, []);
  const sniffed = await importChatFiles(
    [{ download_url: ATTACHMENT, file_id: "file_h2" }],
    options({ downloadFetcher: download, uploadFetcher: upload })
  );
  assert.match(sniffed.failed[0]!.reason, /HEIC\/HEIF/);
  assert.deepEqual(upload.received, []);
});

test("模型传来沙箱里的路径时，说明那不是附件、请用户附上文件", async () => {
  const download = fakeDownload({});
  for (const path of ["/mnt/data/product.png", "sandbox:/mnt/data/product.png", "file:///tmp/a.png"]) {
    const result = await importChatFiles(
      [{ download_url: path, file_id: "file_s", file_name: "product.png" }],
      options({ downloadFetcher: download })
    );
    assert.match(result.failed[0]!.reason, /sandbox.*attach the file/, path);
  }
  assert.deepEqual(download.calls, []);
});

test("域名名单：默认是 OpenAI 自家域名，可用环境变量覆盖", () => {
  assert.deepEqual(chatFileHostsFromEnv({}), ["oaiusercontent.com", "openai.com", "chatgpt.com"]);
  assert.deepEqual(chatFileHostsFromEnv({ MCP_CHAT_FILE_HOSTS: " .Example.com, b.org " }), [
    "example.com",
    "b.org",
  ]);
  assert.ok(isAllowedChatFileHost(new URL(ATTACHMENT), ["oaiusercontent.com"]));
  assert.ok(!isAllowedChatFileHost(new URL("https://oaiusercontent.com.evil.io/x"), ["oaiusercontent.com"]));
  // ChatGPT 实际给的附件地址（2026-10-27 实测）：OpenAI 自己的 Azure 存储账号。
  assert.ok(isAllowedChatFileHost(new URL("https://oaisdmntprwestus.blob.core.windows.net/files/x"), ["oaiusercontent.com"]));
  assert.ok(isAllowedChatFileHost(new URL("https://oaisdmntprjapaneastdr.blob.core.windows.net/f"), []));
  // 其它 Azure 存储账号不放行。
  assert.ok(!isAllowedChatFileHost(new URL("https://evilaccount.blob.core.windows.net/x"), ["oaiusercontent.com"]));
  assert.ok(!isAllowedChatFileHost(new URL("https://oaisdmntprwestus.blob.core.windows.net.evil.io/x"), []));
});

test("工具：声明 ChatGPT 文件参数，文件对象四个字段齐全，调用返回结构化结果", async (t) => {
  const previousKey = process.env.ATLASCLOUD_API_KEY;
  process.env.ATLASCLOUD_API_KEY = "user-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = previousKey;
  });

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerImportChatFilesTool(server, {
    downloadFetcher: fakeDownload({ [ATTACHMENT]: png }),
    uploadFetcher: fakeUpload(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  const tool = tools.find((x) => x.name === "atlas_import_chat_files");
  assert.ok(tool);
  assert.deepEqual(tool._meta?.["openai/fileParams"], ["files"]);
  const files = (tool.inputSchema.properties as Record<string, { items: Record<string, unknown> }>).files;
  assert.deepEqual(Object.keys(files.items.properties as object).sort(), [
    "download_url",
    "file_id",
    "file_name",
    "mime_type",
  ]);
  assert.deepEqual([...(files.items.required as string[])].sort(), ["download_url", "file_id"]);
  assert.equal(files.items.additionalProperties, false);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, false);

  const result = await client.callTool({
    name: "atlas_import_chat_files",
    arguments: {
      idempotency_key: "8c9a1c1e-1d2f-4b8e-9a51-3e0f2a7b6c10",
      files: [{ download_url: ATTACHMENT, file_id: "file_9", file_name: "ref.png" }],
    },
  });
  assert.equal(result.isError, undefined);
  const structured = result.structuredContent as { files: Array<{ url: string }>; failed: unknown[] };
  assert.equal(structured.files[0]!.url, STORED);
  assert.deepEqual(structured.failed, []);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /ref\.png/);
  assert.match(text, new RegExp(STORED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("工具：成功后用同一个 key 重试，宿主换了下载链接也不会重复转存；失败后同一个 key 可以重试", async (t) => {
  const previousKey = process.env.ATLASCLOUD_API_KEY;
  process.env.ATLASCLOUD_API_KEY = "user-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.ATLASCLOUD_API_KEY;
    else process.env.ATLASCLOUD_API_KEY = previousKey;
  });
  const fresh = "https://files.oaiusercontent.com/file-abc?se=later&sig=y";
  const flaky = "https://files.oaiusercontent.com/file-flaky";
  let flakyFails = true;
  const download = fakeDownload({
    [ATTACHMENT]: png,
    [fresh]: png,
    [flaky]: () => (flakyFails ? new Response("busy", { status: 500 }) : png()),
  });
  const upload = fakeUpload();
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerImportChatFilesTool(server, { downloadFetcher: download, uploadFetcher: upload });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = (key: string, url: string, fileId: string) =>
    client.callTool({
      name: "atlas_import_chat_files",
      arguments: { idempotency_key: key, files: [{ download_url: url, file_id: fileId, file_name: "r.png" }] },
    });

  // 成功一次后重试：直接拿缓存，不再下载、不再转存。
  const okKey = "3f6d2b1a-7c4e-4f0a-8b9d-2e1c5a6f7d80";
  assert.equal((await call(okKey, ATTACHMENT, "file_ok")).isError, undefined);
  assert.equal(upload.received.length, 1);
  const replay = await call(okKey, fresh, "file_ok");
  assert.equal(replay.isError, undefined);
  assert.equal(upload.received.length, 1, "同一个 key 的重试不该再转存一次");
  assert.deepEqual(download.calls.filter((u) => u === fresh), []);

  // 全部失败后用同一个 key 重试：不被「结果不确定」挡住，能重新导入。
  const retryKey = "6a1b9c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
  const failed = await call(retryKey, flaky, "file_flaky");
  assert.equal(failed.isError, true);
  assert.match((failed.content as Array<{ text: string }>)[0]!.text, /No file could be stored/);
  flakyFails = false;
  const retried = await call(retryKey, flaky, "file_flaky");
  assert.equal(retried.isError, undefined);
  assert.equal(upload.received.length, 2);
});
