import { assetIdsOfUrls } from "./media-names.js";
import type { UploadTicketStore } from "./upload-ticket-store.js";

/**
 * 提交给生成网关前，把资产库素材的临时地址换成 assetd://<资产编号>。
 *
 * 网站 Playground 从资产库选的素材一直是这样提交的：网关原样存下 assetd:// 引用，只在发给上游的那份里
 * 现签一个临时地址。插件原来提交的是资产库给的 15 分钟临时地址，使用历史里存的就是这个地址（过期后打不开），
 * Seedance 还会被网关登记成上游资产、改写成 asset://atlas-asset-…，控制台的输入栏一律显示「预览不可用」。
 * 换成 assetd:// 后和网站一样：历史里能看到输入图，网关每次派发都现签，确认晚了也不怕地址过期。
 *
 * 报价、读横竖、报价卡缩略图仍然用临时地址（它们要真的拉到文件），只有最后提交的那份换。认不出的地址
 * （上传、对话附件、外部链接）原样提交；查编号出错也原样提交，不因为这一步拦下一单。
 */
const ASSETD_SCHEME = "assetd://";
// 与网关 assetdref.ValidAssetID 一致：asset_ 开头，整串不超过 64 个字符。
const ASSET_ID = /^asset_[A-Za-z0-9_-]{1,58}$/;

function urlsIn(value: unknown, out: Set<string>): Set<string> {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) urlsIn(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) urlsIn(item, out);
  }
  return out;
}

function swapValues(value: unknown, swap: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return swap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => swapValues(item, swap));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swapValues(item, swap)]));
  }
  return value;
}

export async function withAssetLibraryReferences<T extends Record<string, unknown>>(
  body: T,
  store?: UploadTicketStore
): Promise<T> {
  const urls = [...urlsIn(body, new Set())];
  if (urls.length === 0) return body;
  const ids = await assetIdsOfUrls(urls, store);
  const swap = new Map<string, string>();
  for (const [url, assetId] of ids) {
    if (ASSET_ID.test(assetId)) swap.set(url, ASSETD_SCHEME + assetId);
  }
  return swap.size === 0 ? body : (swapValues(body, swap) as T);
}
