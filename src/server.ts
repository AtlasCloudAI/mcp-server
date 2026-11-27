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
  CARD_STATUS_TOOL,
  generationCardEnabled,
  registerCardStatusTool,
  registerGenerationCardResource,
} from "./apps/generation-card.js";
import { registerCardSelftestTool } from "./apps/card-selftest.js";
import { CARD_CHECK_TOOL, registerCancelQuoteTool, registerCardCheckTool } from "./apps/submission-check.js";
import { SERVER_VERSION } from "./version.js";
import { passesChatAttachmentLinks, rendersCards } from "./services/client-profile.js";
import { usesLeanDescriptions } from "./services/chatgpt-lean.js";
import { registerCardUploadPartTool } from "./tools/card-upload.js";
import { TASK_TOOL_NAMES, usesTaskTools } from "./services/chatgpt-task-tools.js";
import { registerChatGptTaskTools } from "./tools/chatgpt-task.js";

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
  // ChatGPT 拿精简版描述（开关 MCP_CHATGPT_LEAN_DESCRIPTIONS，见 services/chatgpt-lean.ts）。
  const lean = profile === "remote" && usesLeanDescriptions(client.clientId);
  // ChatGPT 的任务工具（开关 MCP_CHATGPT_TASK_TOOLS，services/chatgpt-task-tools.ts）。打开时图片、视频只走这 5 个
  // 工具：旧的 atlas_generate_image / video、atlas_quick_generate 不再给 ChatGPT。11-24 正式应用实测，旧工具还在时
  // ChatGPT 做视频 3 次都绕回「list_models → get_model_info → 旧工具」，新工具和卡片用不上。
  const taskTools = profile === "remote" && usesTaskTools(client.clientId);
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
        // ChatGPT 精简版的 atlas_list_models 不列 Workflow（services/chatgpt-lean.ts），这句不给它。
        // 任务工具模式下没有能跑工作流的工具，这句也不给。
        (lean || taskTools
          ? ""
          : "For marketing content such as product ads, UGC videos, try-on or e-commerce listing images, check atlas_list_models with type \"Workflow\" first: those ready-made workflows usually fit better than assembling base models. ") +
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
  registerModelTools(server, { lean });
  if (!taskTools) {
    registerImageTools(server, { lean });
    registerVideoTools(server, { lean });
  }
  registerAudioTools(server);
  registerLLMTools(server, { includeChat: profile === "stdio" || TOOL_POLICIES.atlas_chat.remote });
  if (!taskTools) registerQuickGenerateTools(server, { lean });
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
  // ChatGPT 的图片、视频生成换成「一个任务一个工具」；其他客户端和本地版不受影响。
  if (taskTools) registerChatGptTaskTools(server);

  if (generationCardEnabled()) {
    registerGenerationCardResource(server);
    // 卡片专用工具只给会显示卡片的客户端；不显示卡片的会把它们当普通工具列给模型（问题 48）。
    if (profile === "stdio" || (rendersCards(client.clientId) && !client.noCards)) {
      registerCardStatusTool(server);
      registerCardCheckTool(server, taskTools ? TASK_TOOL_NAMES : []);
      // 用户拒绝或改需求时作废旧报价，旧卡不能再确认（11-13 Jia A12/A14）。
      registerCancelQuoteTool(server, taskTools ? TASK_TOOL_NAMES : []);
      // 上传卡是兜底：模型读得到文件时用 atlas_get_upload_url 自己传（2026-11-11 Cursor）。
      registerUploadCardTool(server);
      // 本地版没有上传中转：上传卡把文件分块交给本地服务（tools/card-upload.ts）。
      if (profile === "stdio") registerCardUploadPartTool(server);
      // 测试卡片只在开发环境用，生产永远不注册。
      const selftest = process.env.MCP_UI_SELFTEST?.trim().toLowerCase();
      if (selftest === "1" || selftest === "true" || selftest === "on") {
        registerCardSelftestTool(server);
      }
    } else if (profile === "remote") {
      // 这次会话按文字版走，但聊天里可能还留着以前画出来的卡片：它们会接着调这两个只读工具刷新进度、
      // 核实提交。没注册就每次都报「工具不存在」，卡片每次加载都重问（11-26 生产：同一用户的 Claude Code
      // 桌面版会画卡片、命令行版不声明 MCP Apps，两边共用一个 OAuth 客户端，命令行一 initialize，
      // 这个客户端就被记成文字版，桌面版里的旧卡片 1.5 小时报了约 2700 次）。照样注册、能调，
      // 但不放进工具列表：模型看不到，列表和以前一字不差（问题 48）。
      registerCardStatusTool(server);
      registerCardCheckTool(server, taskTools ? TASK_TOOL_NAMES : []);
      hideFromToolList(server, CARD_REFRESH_TOOLS);
    }
  }

  return server;
}

/** 文字版会话里照样能调、但不列出来的卡片工具（卡片刷新和核实提交用）。 */
export const CARD_REFRESH_TOOLS: readonly string[] = [CARD_STATUS_TOOL, CARD_CHECK_TOOL];

/**
 * 工具照常注册、能调，只是不出现在 tools/list 里。SDK 没有「能调但不列」的开关（disable() 连调用一起拒），
 * 所以在它的列表处理器外面再包一层，把这几个名字滤掉。只在注册完所有工具之后调。
 */
function hideFromToolList(server: McpServer, names: readonly string[]): void {
  const hidden = new Set(names);
  // McpServer 第一次 registerTool 时装好 tools/list 处理器；这里取出来包一层（SDK 版本锁定，测试兜底）。
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> })
    ._requestHandlers;
  const list = handlers.get("tools/list");
  if (!list) return;
  handlers.set("tools/list", async (request, extra) => {
    const result = (await list(request, extra)) as { tools?: Array<{ name: string }> };
    return Array.isArray(result?.tools) ? { ...result, tools: result.tools.filter((tool) => !hidden.has(tool.name)) } : result;
  });
}
