import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultRouteSummary } from "./services/default-models.js";
import { registerAccountTools } from "./tools/account.js";
import { registerAssetTools } from "./tools/assets.js";
import { registerAudioTools } from "./tools/audio.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerImageTools } from "./tools/image.js";
import { registerImportChatFilesTool } from "./tools/import-chat-files.js";
import { registerLLMTools } from "./tools/llm.js";
import { registerModelTools } from "./tools/models.js";
import { registerPredictionTools } from "./tools/predictions.js";
import { registerQuickGenerateTools } from "./tools/quick-generate.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerUploadCardTool, registerUploadUrlTool } from "./tools/upload-url.js";
import { registerVideoTools } from "./tools/video.js";
import { TOOL_POLICIES } from "./tool-policy.js";
import {
  generationCardEnabled,
  registerCardStatusTool,
  registerGenerationCardResource,
} from "./apps/generation-card.js";
import { registerCardSelftestTool } from "./apps/card-selftest.js";
import { registerCancelQuoteTool, registerCardCheckTool } from "./apps/submission-check.js";
import { SERVER_VERSION } from "./version.js";
import { passesChatAttachmentLinks, rendersCards } from "./services/client-profile.js";
import { registerCardUploadPartTool } from "./tools/card-upload.js";

export type ServerProfile = "stdio" | "remote";

export interface ServerClient {
  /** OAuth client_id of the remote client; decides which client-specific tools to list. */
  clientId?: string;
  /**
   * 认不出的客户端在 initialize 时明确没声明 MCP Apps（GrokBot）：不列卡片专用工具。
   * 没记录（老会话、存储不可用）时照旧列。
   */
  noCards?: boolean;
}

const SERVER_ICON_URL =
  "https://raw.githubusercontent.com/AtlasCloudAI/atlas-cloud-plugin/v0.6.0/plugins/atlas-cloud/assets/app-icon.svg";

export function createAtlasCloudServer(
  profile: ServerProfile = "stdio",
  client: ServerClient = {}
): McpServer {
  const server = new McpServer(
    {
      name: "atlascloud-ai-media",
      title: "Atlas Cloud",
      version: SERVER_VERSION,
      websiteUrl: "https://www.atlascloud.ai",
      // 支持 serverInfo 图标的客户端（GrokBot 等）显示 Atlas 标志，而不是字母头像。
      icons: [{ src: SERVER_ICON_URL, mimeType: "image/svg+xml", sizes: ["any"] }],
    },
    {
      instructions:
        "Use model discovery before generation when the model ID or parameters are uncertain. " +
        "For marketing content such as product ads, UGC videos, try-on or e-commerce listing images, check atlas_list_models with type \"Workflow\" first: those ready-made workflows usually fit better than assembling base models. " +
        "Pick the model and parameters yourself from the user's request and the live catalog; ask only when something material is genuinely ambiguous. " +
        "When the user refers to a file they already have on Atlas Cloud (an earlier upload or result), find it with atlas_search_assets and turn it into an input URL with atlas_use_assets instead of asking them to upload it again. " +
        "Generation tools quote before anything runs. Call once without confirmation_token. If the result is confirmation_required, nothing was spent: show the user that exact model and cost and stop. " +
        defaultRouteSummary() +
        "Only after a new user message explicitly confirms it, call again with unchanged arguments, confirmed: true, the same idempotency_key, and the returned confirmation_token; if the token was lost or mistyped, the server finds the quote from the unchanged arguments. " +
        "Send the token back even if you think it may have lapsed: the server checks expiry itself and says so if it has (only then quote again), so do not judge expiry from a clock. " +
        "If a call submits straight away instead (a charge under a configured auto-submit limit), tell the user the amount. " +
        "Words such as continue, stuck, retry, try again, or keep going never authorize a new quote or another generation submission. After submission, poll the returned prediction_id instead of calling a generation tool again. " +
        "Never invent a model ID or submit if its live schema cannot be loaded and validated. " +
        (generationCardEnabled() && (profile === "stdio" || (rendersCards(client.clientId) && !client.noCards))
          ? "When the user declines a quote or changes a quoted request, withdraw the old quote with atlas_cancel_quote (reason declined or replaced) so its card can't submit it. "
          : "") +
        "These tools already carry the user's Atlas credentials and there is no API key to use, so do not call the Atlas REST API directly with curl.",
    }
  );

  registerDocsTools(server);
  registerModelTools(server);
  registerImageTools(server);
  registerVideoTools(server);
  registerAudioTools(server);
  registerLLMTools(server, { includeChat: profile === "stdio" || TOOL_POLICIES.atlas_chat.remote });
  registerQuickGenerateTools(server);
  registerAccountTools(server);
  registerPredictionTools(server);
  registerAssetTools(server);
  // 两种形态都注册：stdio 下它只会告诉调用方去用 atlas_upload_media。
  // 保持「stdio 暴露全部工具」这条契约不变，契约测试就不用为它开特例。
  registerUploadUrlTool(server);
  // 只给会把附件当下载链接传过来的客户端（ChatGPT）；stdio 照旧全部注册。
  if (profile === "stdio" || passesChatAttachmentLinks(client.clientId)) {
    registerImportChatFilesTool(server);
  }
  if (profile === "stdio") {
    registerUploadTools(server);
  }

  if (generationCardEnabled()) {
    registerGenerationCardResource(server);
    // 卡片专用工具只给会显示卡片的客户端；不显示卡片的会把它们当普通工具列给模型（问题 48）。
    if (profile === "stdio" || (rendersCards(client.clientId) && !client.noCards)) {
      registerCardStatusTool(server);
      registerCardCheckTool(server);
      // 用户拒绝或改需求时作废旧报价，旧卡不能再确认（11-13 Jia A12/A14）。
      registerCancelQuoteTool(server);
      // 上传卡是兜底：模型读得到文件时用 atlas_get_upload_url 自己传（2026-11-11 Cursor）。
      registerUploadCardTool(server);
      // 本地版没有上传中转：上传卡把文件分块交给本地服务（tools/card-upload.ts）。
      if (profile === "stdio") registerCardUploadPartTool(server);
      // 测试卡片只在开发环境用，生产永远不注册。
      const selftest = process.env.MCP_UI_SELFTEST?.trim().toLowerCase();
      if (selftest === "1" || selftest === "true" || selftest === "on") {
        registerCardSelftestTool(server);
      }
    }
  }

  return server;
}
