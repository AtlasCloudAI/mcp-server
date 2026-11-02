import { z } from "zod";
import { api } from "./api-client.js";
import { getModels } from "./doc-fetcher.js";

/**
 * Atlas 自己的营销工作流目录（官网「工作流」页那份），给 atlas_list_models type="Workflow" 用。
 *
 * 为什么要单独一份：工作流在模型目录里只是一堆 atlascloud/studio/* 模型，混在几百个
 * 图片、视频模型中间，没有中文名、分类、要哪些素材。2026-10-23 ChatGPT 实测，用户说
 * 「给保温杯做推广素材，有哪些现成工作流」，助手完全没找到它们，自己拿基础模型拼了方案。
 *
 * 数据源是官网工作流页用的公开接口 /catalog/workflow/list 和 /detail：不需要令牌，所以
 * 托管版也不用等后端给插件令牌放行。同一套接口的 studio 区只有 8 条，缺 Video Clone 和
 * Image Clone（2026-10-27 核对），所以要用 workflow 区。只保留模型目录里确实存在的条目，
 * 列出来的都能直接跑。
 */

const localizedText = z.record(z.string()).optional();

const listResponseSchema = z
  .object({
    data: z
      .object({
        items: z.array(
          z
            .object({
              templateId: z.string(),
              name: z.string(),
              modality: z.string().optional(),
              categoryCode: z.string().optional(),
              isDraft: z.unknown().optional(),
              i18n: z
                .record(z.object({ name: z.string().optional(), intro: z.string().optional() }).passthrough())
                .optional(),
            })
            .passthrough()
        ),
      })
      .passthrough(),
  })
  .passthrough();

const detailResponseSchema = z
  .object({
    data: z
      .object({
        templateId: z.string(),
        model: z.string().optional(),
        intro: z.string().optional(),
        isDraft: z.unknown().optional(),
        showcaseUrl: z.string().optional(),
        slots: z
          .array(
            z
              .object({
                key: z.string(),
                type: z.string().optional(),
                required: z.boolean().optional(),
                multiple: z.boolean().optional(),
                placeholder: localizedText,
              })
              .passthrough()
          )
          .optional(),
        params: z
          .array(
            z
              .object({
                key: z.string(),
                label: localizedText,
                options: z.array(z.unknown()).optional(),
              })
              .passthrough()
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

type ListItem = z.infer<typeof listResponseSchema>["data"]["items"][number];
type Detail = z.infer<typeof detailResponseSchema>["data"];

export interface WorkflowInput {
  key: string;
  type: string;
  label?: string;
  /** 这一项收一组素材（数组），不是单个。 */
  multiple?: boolean;
}

export interface WorkflowOption {
  key: string;
  label?: string;
  choices?: number;
}

export interface WorkflowTemplate {
  templateId: string;
  model: string;
  name: string;
  nameZh?: string;
  modality: string;
  category?: string;
  intro?: string;
  requiredInputs: WorkflowInput[];
  optionalInputs: WorkflowInput[];
  options: WorkflowOption[];
  showcaseUrl?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; templates: WorkflowTemplate[] } | null = null;

function isDraft(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.toLowerCase() === "true");
}

/** wf-ugc-ad / studio-ugc-ad → atlascloud/studio/ugc-ad；详情没给 model 时的退路。 */
export function modelIdFromTemplateId(templateId: string): string | undefined {
  const slug = /^(?:wf|studio)-(.+)$/.exec(templateId)?.[1];
  return slug ? `atlascloud/studio/${slug}` : undefined;
}

/** 把列表项和详情合成一条；拿不到模型 ID 或是草稿时返回 null。 */
export function toWorkflowTemplate(item: ListItem, detail: Detail | null): WorkflowTemplate | null {
  if (isDraft(item.isDraft) || (detail && isDraft(detail.isDraft))) return null;
  const model = detail?.model ?? modelIdFromTemplateId(item.templateId);
  if (!model) return null;
  const slots = detail?.slots ?? [];
  const input = (slot: (typeof slots)[number]): WorkflowInput => ({
    key: slot.key,
    type: slot.type ?? "text",
    ...(slot.placeholder?.en ? { label: slot.placeholder.en } : {}),
    ...(slot.multiple === true ? { multiple: true } : {}),
  });
  return {
    templateId: item.templateId,
    model,
    name: item.name,
    ...(item.i18n?.zh?.name ? { nameZh: item.i18n.zh.name } : {}),
    modality: item.modality ?? "unknown",
    // workflow 区的分类目前就是 image/video，和 modality 重复时不再列一遍
    ...(item.categoryCode && item.categoryCode !== item.modality ? { category: item.categoryCode } : {}),
    ...(detail?.intro ? { intro: detail.intro } : {}),
    requiredInputs: slots.filter((slot) => slot.required === true).map(input),
    optionalInputs: slots.filter((slot) => slot.required !== true).map(input),
    options: (detail?.params ?? []).map((param) => ({
      key: param.key,
      ...(param.label?.en ? { label: param.label.en } : {}),
      ...(param.options && param.options.length > 0 ? { choices: param.options.length } : {}),
    })),
    ...(detail?.showcaseUrl ? { showcaseUrl: detail.showcaseUrl } : {}),
  };
}

async function fetchDetail(templateId: string): Promise<Detail | null> {
  try {
    const res = await api<z.infer<typeof detailResponseSchema>>("/catalog/workflow/detail", {
      requireAuth: false,
      params: { templateId },
      responseSchema: detailResponseSchema,
      maxRetries: 1,
    });
    return res.data;
  } catch {
    return null;
  }
}

export async function getWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.templates;

  const list = await api<z.infer<typeof listResponseSchema>>("/catalog/workflow/list", {
    requireAuth: false,
    params: { page: 1, size: 50 },
    responseSchema: listResponseSchema,
  });
  const [details, models] = await Promise.all([
    Promise.all(list.data.items.map((item) => fetchDetail(item.templateId))),
    getModels(),
  ]);
  const runnable = new Set(models.map((model) => model.model));
  const templates = list.data.items
    .map((item, index) => toWorkflowTemplate(item, details[index] ?? null))
    .filter((template): template is WorkflowTemplate => template !== null && runnable.has(template.model));

  cache = { at: now, templates };
  return templates;
}

function describeInput(input: WorkflowInput): string {
  return `${input.key} (${input.type}${input.multiple ? ", list" : ""})`;
}

export function formatWorkflowList(templates: readonly WorkflowTemplate[], total: number, offset: number): string {
  const lines = [
    `# Atlas Cloud workflows (${templates.length} of ${total})`,
    "",
    "Ready-made marketing workflows. Each one runs as a single job and is quoted as one total before it runs. " +
      "Image workflows run with atlas_generate_image and video workflows with atlas_generate_video, using the model ID below; " +
      "atlas_get_model_info gives the full parameter schema and the price at default settings. " +
      "Image and video inputs (such as product_image) are public URLs; inputs marked list take an array of URLs.",
    "",
  ];
  templates.forEach((template, index) => {
    const title = template.nameZh ? `${template.name} (${template.nameZh})` : template.name;
    const meta = [template.modality, template.category].filter(Boolean).join(" · ");
    lines.push(`${offset + index + 1}. **${title}** — \`${template.model}\` · ${meta}`);
    if (template.intro) lines.push(`   ${template.intro}`);
    if (template.requiredInputs.length > 0) {
      lines.push(`   Required: ${template.requiredInputs.map(describeInput).join(", ")}`);
    }
    if (template.optionalInputs.length > 0) {
      lines.push(`   Optional inputs: ${template.optionalInputs.map(describeInput).join(", ")}`);
    }
    if (template.options.length > 0) {
      lines.push(
        `   Options: ${template.options
          .map((option) => (option.choices ? `${option.key} (${option.choices} choices)` : option.key))
          .join(", ")}`
      );
    }
    if (template.showcaseUrl) lines.push(`   Example: ${template.showcaseUrl}`);
  });
  return lines.join("\n");
}
