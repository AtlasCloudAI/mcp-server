import { createHash } from "node:crypto";
import { getRequestContext } from "./request-context.js";
import { InMemoryUploadTicketStore, type UploadTicketStore } from "./upload-ticket-store.js";

/**
 * 素材的原文件名。
 *
 * 对话里贴的附件、上传卡传的文件、从资产库选的素材，存进 Atlas 以后地址里的文件名是一串随机
 * 编号，报价卡照地址取名就只能显示编号（需求文档 5.2「方案中展示素材缩略图和名称」）。所以在拿到
 * 地址的那一刻记下「地址 → 原文件名」，报价时按地址查回来；查不到就照旧用地址里的名字。
 *
 * 和报价记录共用同一种带过期的键值存储：有 Redis 时多副本也查得到，没有就退回进程内存。键用地址
 * 的摘要，地址很长，资产库的还带签名参数。
 */
export const MEDIA_NAME_REDIS_PREFIX = "atlascloud:mcp:media-name:";

// 一次对话里素材从上传到报价通常几分钟，留一周足够覆盖隔天接着用。
const TTL_SECONDS = 7 * 24 * 3600;
const MAX_NAME_LENGTH = 200;
// 和报价记录一样：Redis 断线时命令会排队挂住，显示名不值得拖住报价。
const STORE_TIMEOUT_MS = 500;

const localNames = new InMemoryUploadTicketStore();

function keyOf(url: string): string {
  return createHash("sha256").update(url).digest("base64url");
}

function storeFor(explicit?: UploadTicketStore): UploadTicketStore {
  return explicit ?? getRequestContext()?.mediaNameStore ?? localNames;
}

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("media name store timed out")), STORE_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** 素材从哪儿来的：资产库、上传卡、对话附件。报价卡在名字下面写一行（设计稿 v2）。 */
export type MediaSource = "library" | "upload" | "chat";

export interface RememberedMedia {
  name: string;
  source?: MediaSource;
  /** 资产库素材的编号：确认生成前按它换新地址、查它还在不在。 */
  assetId?: string;
  /** 资产库的临时地址不带扩展名，认不出是图还是视频：取用时按 MIME 记下，报价卡照它画缩略图。 */
  kind?: MediaKind;
}

export type MediaKind = "image" | "video" | "audio";
const KINDS = new Set<string>(["image", "video", "audio"]);

function kindOfMime(mime: string | undefined): MediaKind | undefined {
  const top = mime?.split("/")[0]?.toLowerCase();
  return top && KINDS.has(top) ? (top as MediaKind) : undefined;
}

const SOURCES = new Set<string>(["library", "upload", "chat"]);

// 带来源或编号时存成 {"name","source","asset_id"}；只有名字时照旧存原文，老记录也照旧读。
function encode(name: string, extra: Omit<RememberedMedia, "name">): string {
  if (!extra.source && !extra.assetId && !extra.kind) return name;
  return JSON.stringify({
    name,
    ...(extra.source ? { source: extra.source } : {}),
    ...(extra.assetId ? { asset_id: extra.assetId } : {}),
    ...(extra.kind ? { kind: extra.kind } : {}),
  });
}

function decode(value: string): RememberedMedia {
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { name?: unknown; source?: unknown; asset_id?: unknown; kind?: unknown };
      if (typeof parsed.name === "string" && parsed.name) {
        return {
          name: parsed.name,
          ...(typeof parsed.source === "string" && SOURCES.has(parsed.source) ? { source: parsed.source as MediaSource } : {}),
          ...(typeof parsed.asset_id === "string" && parsed.asset_id ? { assetId: parsed.asset_id } : {}),
          ...(typeof parsed.kind === "string" && KINDS.has(parsed.kind) ? { kind: parsed.kind as MediaKind } : {}),
        };
      }
    } catch {
      // 不是我们存的 JSON：当成名字
    }
  }
  return { name: value };
}

/** 记下一个素材地址的原文件名（和来源、资产编号）。记不下来不影响上传本身。 */
export async function rememberMediaName(
  url: string,
  name: string,
  store?: UploadTicketStore,
  extra: Omit<RememberedMedia, "name"> = {}
): Promise<void> {
  const cleaned = name.trim().slice(0, MAX_NAME_LENGTH);
  if (!url || !cleaned) return;
  try {
    await withTimeout(storeFor(store).put(keyOf(url), encode(cleaned, extra), TTL_SECONDS));
  } catch {
    // 只是显示名
  }
}

/** 按地址查原文件名和来源；查不到的不在结果里。 */
export async function rememberedMedia(urls: string[], store?: UploadTicketStore): Promise<Map<string, RememberedMedia>> {
  const out = new Map<string, RememberedMedia>();
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      try {
        const value = await withTimeout(storeFor(store).get(keyOf(url)));
        if (value) out.set(url, decode(value));
      } catch {
        // 照旧用地址里的名字
      }
    })
  );
  return out;
}

/** 按地址查原文件名；查不到的不在结果里。 */
export async function rememberedMediaNames(urls: string[], store?: UploadTicketStore): Promise<Map<string, string>> {
  const found = await rememberedMedia(urls, store);
  return new Map([...found].map(([url, media]) => [url, media.name]));
}

// 资产库：换出来的临时地址接口不带名字，名字在搜索结果里。搜索时按资产编号记下，取用时转记到地址上。
const assetKey = (assetId: string): string => `asset:${assetId}`;

export async function rememberAssetNames(assets: Array<{ asset_id: string; name: string }>, store?: UploadTicketStore): Promise<void> {
  await Promise.all(assets.map((asset) => rememberMediaName(assetKey(asset.asset_id), asset.name, store)));
}

export async function rememberAssetUrls(assets: Array<{ asset_id: string; url: string; mime_type?: string }>): Promise<void> {
  const names = await rememberedMediaNames(assets.map((asset) => assetKey(asset.asset_id)));
  await Promise.all(
    assets.map(async (asset) => {
      await rememberAssetIdOfUrl(asset.url, asset.asset_id);
      const name = names.get(assetKey(asset.asset_id));
      const kind = kindOfMime(asset.mime_type);
      if (name) await rememberMediaName(asset.url, name, undefined, { source: "library", assetId: asset.asset_id, ...(kind ? { kind } : {}) });
    })
  );
}

// 资产库临时地址 → 资产编号。上面那条只在知道文件名时才记（报价卡要显示名字）；提交前把地址换成
// assetd:// 引用不需要名字，所以另记一份，模型直接写 asset://asset_… 或没搜索就取用时也认得出来。
const assetUrlKey = (url: string): string => `asset-url:${keyOf(url)}`;

async function rememberAssetIdOfUrl(url: string, assetId: string, store?: UploadTicketStore): Promise<void> {
  if (!url || !assetId) return;
  try {
    await withTimeout(storeFor(store).put(assetUrlKey(url), assetId, TTL_SECONDS));
  } catch {
    // 记不下来就照原地址提交，只是使用历史里没有输入预览
  }
}

/** 这些地址里哪些是资产库的临时地址，对应哪个资产编号；查不到的不在结果里。 */
export async function assetIdsOfUrls(urls: string[], store?: UploadTicketStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const named = await rememberedMedia(urls, store);
  for (const [url, media] of named) if (media.assetId) out.set(url, media.assetId);
  await Promise.all(
    [...new Set(urls)].filter((url) => !out.has(url)).map(async (url) => {
      try {
        const assetId = await withTimeout(storeFor(store).get(assetUrlKey(url)));
        if (assetId) out.set(url, assetId);
      } catch {
        // 照原地址提交
      }
    })
  );
  return out;
}
