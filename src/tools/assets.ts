import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiRequestError, api } from "../services/api-client.js";
import { rememberAssetNames, rememberAssetUrls, rememberedMedia } from "../services/media-names.js";
import { handleError } from "../utils/error-handler.js";
import { describeImageShape, type ImageShape } from "../services/image-size.js";
import { inputLinkCheckEnabled, readImageShapes } from "../services/input-link-check.js";
import { toolAnnotations } from "../tool-policy.js";
import { clientRendersCards, generationCardEnabled } from "../apps/generation-card.js";
import { generationToolCardMeta } from "../apps/generation-quote.js";
import {
  ASSETS_CARD_NOTE,
  ASSETS_MAX_PICK,
  ASSETS_META_KEY,
  type AssetCardData,
  type AssetCardItem,
  type AssetCardKind,
  type AssetMediaType,
  type AssetOrigin,
} from "../apps/asset-library.js";
import { BILLING_URL } from "../constants.js";

// 资产库（官网的 Asset Library）：kubedl 把 /api/v1/assetd/* 代理给 AssetD，账户取自令牌。
// 插件令牌能用的只有搜索（tasks:read）、单个详情（tasks:read）和换原图地址（tasks:write），
// 见 kubedl console/backend/pkg/resourceserver/scope.go。
const ASSETS_PATH = "/assetd/api/assets";

const nullableString = z.string().nullish();

const assetItemSchema = z
  .object({
    asset_id: z.string(),
    media_type: nullableString,
    status: nullableString,
    title: nullableString,
    original_filename: nullableString,
    source_origin: nullableString,
    platform_asset_role: nullableString,
    thumbnail_url: nullableString,
    preview_url: nullableString,
    created_at: nullableString,
    generation_context: z.unknown().optional(),
  })
  .passthrough();

const assetListResponseSchema = z
  .object({
    data: z
      .object({
        items: z.array(assetItemSchema),
        pagination: z.object({ next_cursor: nullableString }).passthrough().nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const sourceUrlsResponseSchema = z
  .object({
    data: z
      .object({
        items: z.array(
          z
            .object({
              asset_id: z.string(),
              source_url: z.string(),
              expires_at: nullableString,
              mime_type: nullableString,
            })
            .passthrough()
        ),
      })
      .passthrough(),
  })
  .passthrough();

type AssetItem = z.infer<typeof assetItemSchema>;

// 官网生成历史归档进来的素材，标题和文件名都是占位的 upload / upload.bin。
const PLACEHOLDER_NAMES = new Set(["upload", "upload.bin", "image", "video", "audio", "file", "blob"]);

const KIND_LABEL: Record<AssetCardKind, string> = { image: "Image", video: "Video", audio: "Audio", "3d": "3D model", other: "File" };
const ORIGIN_LABEL: Record<AssetOrigin, string> = { upload: "upload", generated: "result", input: "input" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function kindOf(item: AssetItem): AssetCardKind {
  const kind = item.media_type?.toLowerCase();
  return kind === "image" || kind === "video" || kind === "audio" || kind === "3d" ? kind : "other";
}

function originOf(item: AssetItem): AssetOrigin {
  if (item.source_origin === "user_upload") return "upload";
  return item.platform_asset_role === "input" ? "input" : "generated";
}

/** 生成上下文里的模型和提示词（AssetD 原样存的生成参数）。 */
function contextOf(item: AssetItem): { model?: string; prompt?: string } {
  const context = record(item.generation_context);
  const params = record(context?.params);
  const model = [context?.model_route, params?.model].find((v): v is string => typeof v === "string" && v !== "");
  const prompt = typeof params?.prompt === "string" ? params.prompt.trim() : "";
  return {
    ...(model ? { model } : {}),
    ...(prompt ? { prompt: prompt.length > 140 ? `${prompt.slice(0, 137)}...` : prompt } : {}),
  };
}

// 模型路由的任务后缀（bytedance/seedance-2.5/image-to-video 的最后一段）：拿来当名字看不出是哪个模型。
const TASK_SEGMENT = /^(?:(?:text|image|video|audio|reference|start-end|first-last)-to-(?:image|video|audio|speech|3d)|edit|i2v|t2v|t2i|r2v)$/i;

// 归档进来的标题有时就是模型路由（atlascloud/studio/product-visuals…），用户看不懂，当作没有标题。
const MODEL_PATH = /^[a-z0-9][\w.-]*\/[\w.-]+\//i;

function modelWord(model: string | undefined): string | undefined {
  const parts = model?.split("/").filter(Boolean) ?? [];
  while (parts.length > 1 && TASK_SEGMENT.test(parts[parts.length - 1]!)) parts.pop();
  return parts.pop();
}

export function assetLabel(item: AssetItem): string {
  for (const name of [item.title, item.original_filename]) {
    const trimmed = name?.trim();
    if (trimmed && !PLACEHOLDER_NAMES.has(trimmed.toLowerCase()) && !MODEL_PATH.test(trimmed)) return trimmed.slice(0, 80);
  }
  const kind = KIND_LABEL[kindOf(item)];
  const origin = ORIGIN_LABEL[originOf(item)];
  const model = modelWord(contextOf(item).model);
  return model ? `${kind} · ${model} ${origin}` : `${kind} ${origin}`;
}

// 签名失败时 AssetD 退回相对路径（要带凭据才能取），卡片和模型都用不了，丢掉。
function httpsUrl(value: string | null | undefined): string | undefined {
  return value && /^https:\/\//i.test(value) ? value : undefined;
}

export function assetCardItem(item: AssetItem): AssetCardItem {
  const kind = kindOf(item);
  const thumb = httpsUrl(item.thumbnail_url);
  const preview = httpsUrl(item.preview_url);
  const { model } = contextOf(item);
  return {
    asset_id: item.asset_id,
    label: assetLabel(item),
    kind,
    origin: originOf(item),
    ...(thumb ? { thumb_url: thumb } : {}),
    // 图片的预览是大图，缩略图够了；视频没有缩略图，用预览取第一帧。
    ...(preview && kind !== "image" ? { preview_url: preview } : {}),
    ...(item.created_at ? { created_at: item.created_at } : {}),
    ...(model ? { model } : {}),
  };
}

export interface AssetSearchArgs {
  query?: string;
  media_type?: AssetMediaType;
  limit: number;
  cursor?: string;
}

export async function searchAssets(args: AssetSearchArgs): Promise<{ items: AssetItem[]; nextCursor?: string }> {
  const result = await api<z.infer<typeof assetListResponseSchema>>(ASSETS_PATH, {
    params: {
      q: args.query,
      media_type: args.media_type,
      limit: args.limit,
      cursor: args.cursor,
      // 只给能用的：上传中、处理中、已过期、已删除的拿去生成都会失败。
      status: "ready",
    },
    responseSchema: assetListResponseSchema,
  });
  const next = result.data.pagination?.next_cursor;
  return { items: result.data.items, ...(next ? { nextCursor: next } : {}) };
}

export interface ResolvedAsset {
  asset_id: string;
  url: string;
  expires_at?: string;
  mime_type?: string;
}

async function sourceUrls(ids: string[]): Promise<ResolvedAsset[]> {
  const result = await api<z.infer<typeof sourceUrlsResponseSchema>>(`${ASSETS_PATH}/source-urls`, {
    method: "POST",
    body: { asset_ids: ids },
    responseSchema: sourceUrlsResponseSchema,
  });
  return result.data.items.map((item) => ({
    asset_id: item.asset_id,
    url: item.source_url,
    ...(item.expires_at ? { expires_at: item.expires_at } : {}),
    ...(item.mime_type ? { mime_type: item.mime_type } : {}),
  }));
}

/**
 * 换临时原图地址。AssetD 整批处理：有一个找不到（已删除、过期、不是这个账户的）整批 404，
 * 这时逐个再换一次，把找不到的挑出来告诉模型，其余照常可用。
 */
export async function resolveAssets(ids: string[]): Promise<{ resolved: ResolvedAsset[]; missing: string[] }> {
  try {
    return { resolved: await sourceUrls(ids), missing: [] };
  } catch (error) {
    if (!(error instanceof ApiRequestError && error.statusCode === 404) || ids.length === 1) {
      if (error instanceof ApiRequestError && error.statusCode === 404) return { resolved: [], missing: ids };
      throw error;
    }
  }
  const resolved: ResolvedAsset[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    try {
      resolved.push(...(await sourceUrls([id])));
    } catch (error) {
      if (error instanceof ApiRequestError && error.statusCode === 404) missing.push(id);
      else throw error;
    }
  }
  return { resolved, missing };
}

/** 参数里所有链接（多层对象、数组里的也算）。 */
function urlsIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) urlsIn(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) urlsIn(item, out);
  }
  return out;
}

/** 按对照表换掉参数里的链接（只换整串相等的值），结构原样。 */
export function replaceUrls<T>(value: T, swap: ReadonlyMap<string, string>): T {
  if (swap.size === 0) return value;
  if (typeof value === "string") return (swap.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => replaceUrls(item, swap)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceUrls(item, swap)])) as T;
  }
  return value;
}

export type LibraryInputRefresh =
  | {
      ok: true;
      params: Record<string, unknown>;
      /** 新地址 → 报价时的地址。确认令牌按报价时的请求核对，核对前要换回去。 */
      original: Map<string, string>;
    }
  | { ok: false; message: string };

/**
 * 确认生成前，把参数里从资产库取来的素材换成新的临时地址：资产库给的地址 15 分钟就过期，报价却能
 * 等一个小时，过了 15 分钟再确认，网关就拉不到图。顺便查出这期间被删掉的素材（设计稿 v2「素材失效」），
 * 这时什么都不提交。认得出资产编号的才换（取用时记在 media-names 里）；资产库本身出错时照原地址提交，
 * 不因为换不了地址拦下这一单。
 */
export async function refreshLibraryInputs(params: Record<string, unknown>): Promise<LibraryInputRefresh> {
  const unchanged: LibraryInputRefresh = { ok: true, params, original: new Map() };
  const urls = [...urlsIn(params)];
  if (urls.length === 0) return unchanged;
  const remembered = await rememberedMedia(urls);
  const fromLibrary = urls.flatMap((url) => {
    const media = remembered.get(url);
    return media?.assetId ? [{ url, assetId: media.assetId, name: media.name }] : [];
  });
  if (fromLibrary.length === 0) return unchanged;

  let resolved: ResolvedAsset[];
  let missing: string[];
  try {
    ({ resolved, missing } = await resolveAssets([...new Set(fromLibrary.map((input) => input.assetId))]));
  } catch (error) {
    console.error(`[assets] couldn't refresh library inputs before submit: ${error instanceof Error ? error.message : String(error)}`);
    return unchanged;
  }
  if (missing.length > 0) {
    const names = fromLibrary.filter((input) => missing.includes(input.assetId)).map((input) => input.name);
    const one = names.length === 1;
    return {
      ok: false,
      message:
        `Error: ${one ? "An input file is" : "Input files are"} no longer available: ${names.join(", ")} ` +
        `(deleted from the Asset Library). Nothing was submitted or charged. Ask the user to choose another file, then quote again.`,
    };
  }

  const fresh = new Map(resolved.map((asset) => [asset.asset_id, asset.url]));
  const swap = new Map<string, string>();
  const original = new Map<string, string>();
  for (const input of fromLibrary) {
    const url = fresh.get(input.assetId);
    if (!url || url === input.url) continue;
    swap.set(input.url, url);
    original.set(url, input.url);
  }
  // 新地址也记上名字和编号：进度卡、再次确认时照样认得。
  await rememberAssetUrls(resolved);
  return { ok: true, params: replaceUrls(params, swap), original };
}

/** 参数里整串写成 Atlas 资产编号的值：asset://asset_… 或 asset_…。 */
const ASSET_REFERENCE = /^(?:asset:\/\/)?(asset_[A-Za-z0-9_-]{8,58})$/;

function assetReferencesIn(value: unknown, out = new Map<string, string>()): Map<string, string> {
  if (typeof value === "string") {
    const id = ASSET_REFERENCE.exec(value.trim())?.[1];
    if (id) out.set(value, id);
  } else if (Array.isArray(value)) {
    for (const item of value) assetReferencesIn(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) assetReferencesIn(item, out);
  }
  return out;
}

/**
 * 参数里直接写的 Atlas 资产编号换成资产库的临时地址。验收问题 31（ChatGPT，11-03）：卡片把资产编号和地址
 * 一起交给模型，Seedance 2.5 的 schema 又写着 image 可以填「asset reference (asset://<ASSET_ID>)」，模型就填了
 * asset://asset_…。那是上游自己资产库的编号，认不出 Atlas 的；而且不是链接，报价卡没有输入图、读不出横竖。
 * 换成地址后和用户直接给链接一样走。original 记着「地址 → 原来写的编号」：确认令牌按模型传的参数核对。
 */
export async function resolveAssetReferences(params: Record<string, unknown>): Promise<LibraryInputRefresh> {
  const refs = assetReferencesIn(params);
  if (refs.size === 0) return { ok: true, params, original: new Map() };
  let resolved: ResolvedAsset[];
  let missing: string[];
  try {
    ({ resolved, missing } = await resolveAssets([...new Set(refs.values())]));
  } catch (error) {
    console.error(`[assets] couldn't resolve asset references in params: ${error instanceof Error ? error.message : String(error)}`);
    return {
      ok: false,
      message:
        "Error: Couldn't look up the Asset Library files named in params right now. Nothing was submitted or charged. " +
        "Pass the file URLs from atlas_use_assets instead, or try again.",
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `Error: ${missing.map((id) => `\`${id}\``).join(", ")} ${missing.length === 1 ? "is" : "are"} not in this account's Asset Library ` +
        "(deleted, expired or a different account). Nothing was submitted or charged. Search again with atlas_search_assets, or ask the user for the file.",
    };
  }
  const url = new Map(resolved.map((asset) => [asset.asset_id, asset.url]));
  const swap = new Map<string, string>();
  const original = new Map<string, string>();
  for (const [written, id] of refs) {
    const fresh = url.get(id);
    if (!fresh) continue;
    swap.set(written, fresh);
    original.set(fresh, written);
  }
  // 记上名字和编号：报价卡写「Asset Library」和原文件名，确认时 refreshLibraryInputs 也认得。
  await rememberAssetUrls(resolved);
  return { ok: true, params: replaceUrls(params, swap), original };
}

/**
 * 生成工具收到参数后先过这一步：资产编号换成地址（报价、确认都换），确认时再把资产库的地址换成新的。
 * original 合成一张表：最后提交的地址 → 模型当初传的值。
 */
export async function libraryInputs(params: Record<string, unknown>, confirming: boolean): Promise<LibraryInputRefresh> {
  const refs = await resolveAssetReferences(params);
  if (!refs.ok || !confirming) return refs;
  const refreshed = await refreshLibraryInputs(refs.params);
  if (!refreshed.ok) return refreshed;
  const original = new Map(refs.original);
  for (const [fresh, before] of refreshed.original) original.set(fresh, refs.original.get(before) ?? before);
  return { ok: true, params: refreshed.params, original };
}

/**
 * 上传前查一下资产库能不能用（资产库二期要充值后才开通）：能用，atlas_get_upload_url 就签一张把字节
 * 存进资产库的票；查不了（没开通、AssetD 出错）就照旧走 /model/uploadMedia，不因为这一步拦下上传。
 */
export async function assetLibraryAvailable(): Promise<boolean> {
  try {
    await searchAssets({ limit: 1 });
    return true;
  } catch (error) {
    if (!assetLibraryLocked(error)) {
      console.error(`[assets] couldn't check the Asset Library before an upload: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}


/** 资产库要充值后才能用（资产库二期）：AssetD 回 403 asset_library_not_activated。 */
function assetLibraryLocked(error: unknown): boolean {
  return error instanceof ApiRequestError && error.statusCode === 403 && /asset_library_not_activated/i.test(error.message);
}

/** 资产库接口特有的几种失败；其余交给通用的 handleError。 */
export function assetErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    // kubedl 还没给插件令牌放开资产库（旧版本后端），或这个环境没开资产库。
    if (error.statusCode === 401 && /does not accept scoped access tokens/i.test(error.message)) {
      return (
        "Error: The Asset Library isn't available to this Atlas Cloud connection yet. " +
        "Ask the user to upload the file with atlas_get_upload_url or share a public link instead."
      );
    }
    if (assetLibraryLocked(error)) {
      return (
        "Error: The user's Asset Library isn't activated yet. It turns on after they add balance at " +
        `${BILLING_URL}. Until then, ask them to upload the file from their device with atlas_get_upload_url.`
      );
    }
    if (error.statusCode === 403 && /scope/i.test(error.message)) {
      return (
        "Error: This Atlas Cloud connection wasn't granted access for that. " +
        "Ask the user to reconnect Atlas Cloud and approve the requested access, then try again."
      );
    }
    if (error.statusCode === 404) {
      return "Error: The Asset Library isn't available on this account yet. Ask the user to upload the file instead.";
    }
  }
  return handleError(error);
}

function describe(item: AssetItem, index: number): string[] {
  const { model, prompt } = contextOf(item);
  const parts = [`${index + 1}. **${assetLabel(item)}** — ${kindOf(item)} — \`${item.asset_id}\``];
  if (item.created_at) parts[0] += ` — ${item.created_at}`;
  if (model) parts.push(`   ${originOf(item) === "upload" ? "uploaded" : `${ORIGIN_LABEL[originOf(item)]} of`} ${model}`);
  if (prompt) parts.push(`   prompt: ${prompt}`);
  return parts;
}

const assetIdSchema = z
  .string()
  .regex(/^asset_[A-Za-z0-9_-]{1,58}$/, "Asset IDs look like asset_ followed by letters and digits");

export function registerAssetTools(server: McpServer): void {
  server.registerTool(
    "atlas_search_assets",
    {
      title: "Search Asset Library",
      description: `Search the user's Atlas Cloud Asset Library: files they uploaded on atlascloud.ai and the inputs and results of their earlier generations.

Use this when the user wants to reuse something they already have ("use my product photo", "the video I made yesterday") instead of uploading it again. It only reads the library — nothing is uploaded, generated or billed.

Args:
  - query (string, optional): words to match against asset names and descriptions
  - media_type (string, optional): "image" | "video" | "audio" | "3d"
  - limit (integer, optional, default 12, max 50): assets per page
  - cursor (string, optional): next_cursor from a previous page

Returns:
  count, next_cursor and the assets (asset_id, name, media_type, origin, created_at, model, prompt, thumbnail_url).

To use assets as generation inputs, call atlas_use_assets with their asset_id values; it returns temporary file URLs for the generation tools. In chat apps that show Atlas cards (ChatGPT, Claude), the results open in an Asset Library card where the user can pick assets themselves.`,
      inputSchema: {
        query: z.string().trim().min(1).max(200).optional().describe("Words to match against asset names and descriptions"),
        media_type: z.enum(["image", "video", "audio", "3d"]).optional().describe("Only this media type"),
        limit: z.number().int().min(1).max(50).default(12).describe("Assets per page (max 50)"),
        cursor: z.string().min(1).max(1000).optional().describe("next_cursor from a previous page"),
      },
      outputSchema: {
        count: z.number().int().nonnegative(),
        next_cursor: z.string().optional(),
        /** 资产库没开通时为 false（充值后才能用）。 */
        activated: z.boolean().optional(),
        /** 这个词一个都没搜到，列的是最近的素材。 */
        unmatched_query: z.string().optional(),
        assets: z.array(
          z.object({
            asset_id: z.string(),
            name: z.string(),
            media_type: z.string(),
            origin: z.enum(["upload", "generated", "input"]),
            created_at: z.string().optional(),
            model: z.string().optional(),
            prompt: z.string().optional(),
            thumbnail_url: z.string().optional(),
          })
        ),
      },
      annotations: toolAnnotations("atlas_search_assets"),
      ...generationToolCardMeta(),
    },
    async ({ query, media_type, limit, cursor }) => {
      try {
        let { items, nextCursor } = await searchAssets({ query, media_type, limit, cursor });
        // 资产名多是英文文件名或模型 ID，用中文等别的语言搜几乎搜不到，用户有图也会被引去重新上传
        // （验收问题 20：ChatGPT 按「耳机」搜）。没搜到就改列最近的，让用户自己挑。
        const unmatched = query && !cursor && items.length === 0 ? query : undefined;
        if (unmatched) ({ items, nextCursor } = await searchAssets({ media_type, limit }));
        const assets = items.map((item) => {
          const { model, prompt } = contextOf(item);
          const thumb = httpsUrl(item.thumbnail_url);
          return {
            asset_id: item.asset_id,
            name: assetLabel(item),
            media_type: kindOf(item),
            origin: originOf(item),
            ...(item.created_at ? { created_at: item.created_at } : {}),
            ...(model ? { model } : {}),
            ...(prompt ? { prompt } : {}),
            ...(thumb ? { thumbnail_url: thumb } : {}),
          };
        });

        await rememberAssetNames(assets);

        const lines = [
          unmatched
            ? `# Asset Library (nothing matches "${unmatched}"; ${assets.length} most recent)`
            : `# Asset Library (${assets.length}${query ? ` matching "${query}"` : ""})`,
          "",
        ];
        if (clientRendersCards(server)) lines.push(ASSETS_CARD_NOTE, "");
        if (unmatched && items.length > 0) {
          lines.push(
            `No assets match "${unmatched}". Asset names are usually English file names or model IDs, so words in other ` +
              "languages rarely match. These are the most recent assets instead: let the user pick one, or search again in English " +
              "before asking them to upload.",
            ""
          );
        }
        if (items.length === 0) {
          lines.push(
            query || media_type || cursor
              ? "No assets match. Try other words or no filter, or ask the user to upload the file with atlas_get_upload_url."
              : "The Asset Library is empty. Ask the user to upload the file with atlas_get_upload_url."
          );
        }
        items.forEach((item, index) => lines.push(...describe(item, index)));
        if (items.length > 0) {
          lines.push(
            "",
            "To use assets as generation inputs, call atlas_use_assets with their asset_id values. " +
              "Do not pass asset IDs or thumbnail URLs to the generation tools directly."
          );
        }
        if (nextCursor) lines.push(`More assets: call again with cursor="${nextCursor}".`);

        const card: AssetCardData | undefined = generationCardEnabled()
          ? {
              view: "assets",
              ...(unmatched ? { unmatched_query: unmatched } : query ? { query } : {}),
              ...(media_type ? { media_type } : {}),
              items: items.map(assetCardItem),
              ...(nextCursor ? { next_cursor: nextCursor } : {}),
              max_pick: ASSETS_MAX_PICK,
            }
          : undefined;
        return {
          ...(card ? { _meta: { [ASSETS_META_KEY]: card } } : {}),
          structuredContent: {
            count: assets.length,
            ...(nextCursor ? { next_cursor: nextCursor } : {}),
            ...(unmatched ? { unmatched_query: unmatched } : {}),
            assets,
          },
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        // 没开通不算出错：卡片照常打开，显示「充值后能用，或者先从设备上传」（设计稿 v2「资产库未开通」）。
        if (assetLibraryLocked(error) && generationCardEnabled()) {
          const card: AssetCardData = { view: "assets", items: [], max_pick: ASSETS_MAX_PICK, locked: true };
          return {
            _meta: { [ASSETS_META_KEY]: card },
            structuredContent: { count: 0, assets: [], activated: false },
            content: [{ type: "text", text: assetErrorText(error).replace(/^Error: /, "") }],
          };
        }
        return { isError: true, content: [{ type: "text", text: assetErrorText(error) }] };
      }
    }
  );

  server.registerTool(
    "atlas_use_assets",
    {
      title: "Use Library Assets",
      description: `Get temporary file URLs for assets in the user's Asset Library, to pass as the image/video/audio URL parameters of generation tools.

Use this after atlas_search_assets (or when the user's message gives asset IDs) and right before generating. Nothing is generated or billed; Atlas logs that the assets were used.

Args:
  - asset_ids (string[], 1-${ASSETS_MAX_PICK}): asset_id values from atlas_search_assets

Returns:
  the URLs with their expiry, the size and shape of images (landscape, portrait or square), and any asset IDs that are no longer available.

Rules:
  - The URLs expire after about 15 minutes. Generate soon; if a generation can't fetch one, call this tool again for fresh URLs.
  - Do not show the URLs to the user or store them; they are signed links to the user's private files.`,
      inputSchema: {
        asset_ids: z
          .array(assetIdSchema)
          .min(1)
          .max(ASSETS_MAX_PICK)
          .describe("asset_id values from atlas_search_assets"),
      },
      outputSchema: {
        assets: z.array(
          z.object({
            asset_id: z.string(),
            url: z.string(),
            expires_at: z.string().optional(),
            mime_type: z.string().optional(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            orientation: z.enum(["landscape", "portrait", "square"]).optional(),
            ratio: z.string().optional(),
          })
        ),
        missing: z.array(z.string()),
      },
      annotations: toolAnnotations("atlas_use_assets"),
      // 资产库卡里点「Use selected」时卡片自己调它。它的结果不画卡片，所以不挂 resourceUri，
      // 只声明卡片可以调（ChatGPT 认这个键）。
      ...(generationCardEnabled() ? { _meta: { "openai/widgetAccessible": true } } : {}),
    },
    async ({ asset_ids }) => {
      const ids = [...new Set(asset_ids)];
      try {
        const { resolved, missing } = await resolveAssets(ids);
        await rememberAssetUrls(resolved);
        // 图片的宽高和横竖：模型看不到图，要竖屏视频时据此先跟用户说清楚（问题 13）。
        const shapes = inputLinkCheckEnabled()
          ? await readImageShapes(
              resolved.filter((asset) => !asset.mime_type || asset.mime_type.startsWith("image/")).map((asset) => asset.url)
            )
          : new Map<string, ImageShape>();
        const assets = resolved.map((asset) => {
          const shape = shapes.get(asset.url);
          return shape
            ? { ...asset, width: shape.width, height: shape.height, orientation: shape.orientation, ratio: shape.ratio }
            : asset;
        });
        const lines = ["# Asset URLs", ""];
        for (const asset of resolved) {
          const shape = shapes.get(asset.url);
          const about = [asset.mime_type, shape ? describeImageShape(shape) : undefined].filter(Boolean).join(", ");
          lines.push(`- \`${asset.asset_id}\`${about ? ` (${about})` : ""}: ${asset.url}`);
        }
        if (missing.length > 0) {
          lines.push(
            "",
            `Not available (deleted, expired or not in this account): ${missing.map((id) => `\`${id}\``).join(", ")}. ` +
              "Search again or ask the user to upload the file."
          );
        }
        if (resolved.length > 0) {
          const expiry = resolved.map((asset) => asset.expires_at).filter(Boolean).sort()[0];
          lines.push(
            "",
            // 生成工具里写 asset:// 编号更好：不过期，请求里也没有签名地址（验收问题 36）。
            "In a generation tool's params, asset://<asset ID> works in place of these URLs: the server swaps in a fresh URL, " +
              `so it does not expire. The URLs themselves expire${expiry ? ` at ${expiry}` : " in about 15 minutes"}; ` +
              "if one can't be fetched, call atlas_use_assets again. Don't show these links to the user."
          );
        }
        return {
          ...(resolved.length === 0 ? { isError: true } : {}),
          structuredContent: { assets, missing },
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: assetErrorText(error) }] };
      }
    }
  );
}
