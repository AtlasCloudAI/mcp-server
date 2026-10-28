// 资产库卡：设计稿「全屏视图」里的「从资产库选取 assets list」和「资产库为空 assets empty」。
// atlas_search_assets 在卡片打开时附上这份数据；上传卡里点「Choose from Asset Library」时，
// 卡片自己调 atlas_search_assets 拿到同样的数据。用户选好后，卡片调 atlas_use_assets 换成
// 临时原图地址，像上传卡一样交给模型。卡片前端在 ui/generation-card/assets.ts，两边字段要对上。

/** 结果里给资产库卡的数据放在这个 _meta 键下。 */
export const ASSETS_META_KEY = "atlascloud/assets";

/** 一次最多选几个素材交给模型，和上传卡一致。 */
export const ASSETS_MAX_PICK = 10;

export type AssetMediaType = "image" | "video" | "audio";
export type AssetCardKind = AssetMediaType | "other";
export type AssetOrigin = "upload" | "generated" | "input";

export interface AssetCardItem {
  asset_id: string;
  /** 给人看的名字：标题或文件名；都没意义时用类型 + 模型。 */
  label: string;
  kind: AssetCardKind;
  origin: AssetOrigin;
  /** 签名缩略图（图片才有）。 */
  thumb_url?: string;
  /** 签名预览：视频用它取第一帧。 */
  preview_url?: string;
  created_at?: string;
  /** 生成这份素材（或用它做输入）的模型。 */
  model?: string;
}

export interface AssetCardData {
  view: "assets";
  query?: string;
  media_type?: AssetMediaType;
  items: AssetCardItem[];
  /** 还有下一页时的游标。 */
  next_cursor?: string;
  max_pick: number;
  /** 测试卡片：只显示，不真的换地址。 */
  sample?: boolean;
}

/** 模型在卡片打开时看到的说明：让用户在卡里挑，挑好的地址会自己回来。 */
export const ASSETS_CARD_NOTE =
  "An Atlas Asset Library card is now showing these assets in the chat. The user can pick some there; when they press " +
  "\"Use selected\", temporary URLs for the picked assets arrive in a new message or in your context. If the user " +
  "already named the asset they want, you may call atlas_use_assets with its asset_id instead of waiting.";
