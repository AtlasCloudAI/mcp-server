import assert from "node:assert/strict";
import test from "node:test";

process.env.ATLASCLOUD_API_KEY ??= "test-key";

// 11-17 Jia B6：结果卡刷新前是 Download + Reuse prompt，刷新后变成 Download + View request。
// 刷新后报价卡先核实「提交过没有」，找到任务就用 startedCard 拼卡；那里查详情没带 include_input，
// 拿不到原始请求，卡上没有提示词，Reuse 按钮就没了。
test("the card rebuilt after a page refresh asks for the original request and keeps Reuse", async () => {
  const { startedCard } = await import("../src/apps/submission-check.js");
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const withInput = new URL(url).searchParams.get("include_input") === "1";
    return new Response(
      JSON.stringify({
        code: 200,
        data: {
          id: "b6b6b6b6",
          model: "bytedance/seedream-v5.0-flash/text-to-image",
          status: "processing",
          outputs: [],
          ...(withInput ? { input: '{"prompt":"a blue paper airplane","size":"2048*2048"}' } : {}),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const card = await startedCard("b6b6b6b6", "bytedance/seedream-v5.0-flash/text-to-image", { fetcher });
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]!).searchParams.get("include_input"), "1");
  assert.equal(card.prediction_id, "b6b6b6b6");
  assert.equal(card.prompt, "a blue paper airplane");
});
