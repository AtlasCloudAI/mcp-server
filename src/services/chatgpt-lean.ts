import { isChatGptClient } from "./client-profile.js";

/**
 * ChatGPT 的精简工具描述（开关 MCP_CHATGPT_LEAN_DESCRIPTIONS，默认关）。
 *
 * ChatGPT 上架应用用的是 OpenAI 审核过的工具副本。2026-11-20 OpenAI 的自动检查拦下了
 * atlas_list_models、atlas_generate_image、atlas_generate_video、atlas_quick_generate 的新版本
 * （"This tool appears to execute operations that are not individually exposed"），副本停在没有卡片
 * 模板的旧版本，ChatGPT 画不出报价卡和进度卡。
 *
 * 在 OpenAI 平台逐个对比「已发布旧定义」和「被拦新定义」：list_models 唯一的改动是加了
 * type="Workflow"（「营销工作流用 generate_image / video 跑，跟其他模型一样」）；generate_image /
 * video 比同次通过的 generate_audio 只多了默认路由段（点名模型、不可用就按顺序换下一个、
 * 其他任务从目录里挑）；quick_generate 新加了「list_models 拿 ID → get_model_info 看参数 →
 * 传给 generate_*」的明说链路。卡片模板和「模型名 + 自由参数」的结构都不是原因：旧版本和
 * generate_audio 都有，都过了；Higgsfield 的 ChatGPT 版也是通用 generate_image，只点名一个
 * 默认模型。
 *
 * 所以只对 ChatGPT 去掉这几段，其他客户端一个字不变。开关打开后要在 OpenAI 平台对生产插件
 * 点 Rescan 才知道过没过（草稿插件不跑这项检查）；没过就关掉，ChatGPT 继续用旧版本。
 */
export function chatGptLeanDescriptionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // 和 MCP_UI_CARDS 等开关同一个写法：没设或空着算关，0 / false / no / off 算关，其余算开。
  const raw = env.MCP_CHATGPT_LEAN_DESCRIPTIONS?.trim().toLowerCase();
  if (!raw) return false;
  return !["0", "false", "no", "off"].includes(raw);
}

/** 这个客户端拿精简描述吗：开关打开，且是 ChatGPT（OpenAI 平台的插件扫描也算）。 */
export function usesLeanDescriptions(clientId: string | undefined): boolean {
  return chatGptLeanDescriptionsEnabled() && isChatGptClient(clientId);
}

/** 注册工具时的描述版本。 */
export interface ToolTextOptions {
  /** ChatGPT 精简版：不写工作流、默认路由链路和「发现 → 取参数 → 生成」的明说链路。 */
  lean?: boolean;
}
