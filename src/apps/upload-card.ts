// 对话内的上传卡：设计稿「上传 · Upload」。atlas_get_upload_url 在卡片打开时附上这份数据，
// 卡片里选文件，浏览器直接 POST 到上传中转（/upload/:ticket），传完把地址交给模型。
// 卡片前端的解析和状态在 ui/generation-card/upload.ts，两边字段要对上。

/** 结果里给上传卡的数据放在这个 _meta 键下。 */
export const UPLOAD_META_KEY = "atlascloud/upload";

/** 一张卡最多传几个文件。参考素材一般一两张，多了模型也用不上。 */
export const UPLOAD_MAX_FILES = 10;

export type UploadFileKind = "image" | "video" | "audio" | "other";
export type UploadFileStatus = "uploading" | "done" | "invalid" | "failed";

/** 测试卡片里预先摆好的文件（真实上传时文件只在卡片里）。 */
export interface UploadSampleFile {
  name: string;
  size_bytes: number;
  kind: UploadFileKind;
  status: UploadFileStatus;
  /** 0~1，status 为 uploading 时用。 */
  progress?: number;
  /** 缩略图（测试卡片用公开示例图）。 */
  url?: string;
  error?: string;
}

export interface UploadCardData {
  view: "upload";
  upload_url: string;
  expires_at: string;
  max_bytes: number;
  max_files: number;
  /** 测试卡片：只显示，不真传。 */
  sample?: boolean;
  sample_files?: UploadSampleFile[];
  /** 测试卡片：直接显示「上传链接过期」。 */
  sample_expired?: boolean;
}

export function uploadCardData(issued: { uploadUrl: string; expiresAt: number; maxBytes: number }): UploadCardData {
  return {
    view: "upload",
    upload_url: issued.uploadUrl,
    expires_at: new Date(issued.expiresAt).toISOString(),
    max_bytes: issued.maxBytes,
    max_files: UPLOAD_MAX_FILES,
  };
}

/** 模型在卡片打开时看到的说明：别再让用户贴附件、跑 curl，等卡片把地址交回来。 */
export const UPLOAD_CARD_NOTE =
  "An Atlas upload card is now showing in the chat. The user picks or drops their files there and the card " +
  "uploads them; when they press \"Use files\", the uploaded URLs arrive in a new message or in your context. " +
  "Do not ask the user to attach the files in the chat, and do not run the upload command yourself. " +
  "Briefly tell the user to add their files in the card, then wait.";
