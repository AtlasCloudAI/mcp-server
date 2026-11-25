import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { quoteBalanceNotice } from "../services/quote-balance.js";
import { prepareGeneration, submitPreparedGeneration } from "../services/generation.js";
import {
  alreadySubmittedLine,
  formatGenerationPricing,
  issueGenerationConfirmation,
  resolveConfirmedIdempotencyKey,
} from "../services/generation-confirmation.js";
import { executeIdempotently } from "../services/idempotency.js";
import { handleError } from "../utils/error-handler.js";
import { completedOutputContent } from "../services/media-preview.js";
import { currentClientProfile } from "../services/client-profile.js";
import { getModels } from "../services/doc-fetcher.js";
import { pickDefaultModel } from "../services/default-models.js";
import {
  autoSubmitNotice,
  confirmationCostNotice,
  confirmationReuseNotice,
  confirmationValidityNotice,
  costEstimate,
  evaluateSpend,
  type SpendDecision,
} from "../services/spend-policy.js";
import {
  generationConfirmationStructuredContent,
  generationConfirmationTokenSchema,
  generationConfirmedSchema,
  generationIdempotencyKeySchema,
  generationOutputSchema,
  generationStructuredContent,
  generationWhyThisModelSchema,
} from "../tool-contracts.js";
import { TASK_TOOL_POLICIES } from "../tool-policy.js";
import { generationToolCardMeta, withGenerationCard } from "../apps/generation-quote.js";
import { libraryInputs, replaceUrls } from "./assets.js";
import { inputImageSummaries, inputShapeNotice } from "./video.js";
import {
  CHOICE_ROUTE_NAME,
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODEL_CHOICES,
  TASK_OF_TOOL,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODEL_CHOICES,
  VIDEO_RESOLUTIONS,
  imageParams,
  modelIdFor,
  videoParams,
  type ImageModelChoice,
  type ModelChoice,
  type TaskToolName,
  type VideoModelChoice,
  type VideoTaskArgs,
} from "../services/chatgpt-task-tools.js";

// ChatGPT 专用的任务工具（services/chatgpt-task-tools.ts 写了为什么）。处理流程和 atlas_generate_image /
// video 一样：素材换地址 → 按 schema 校验 → 报价 → 确认后提交；区别只在模型和参数由固定字段换算出来。

/**
 * 素材地址：HTTPS，或资产库的 asset://（服务端换成地址，和其他生成工具一样）。每个字段各建一个：
 * 同一个 zod 实例用在两处，生成的 JSON Schema 第二处会变成 $ref，有的客户端读不出类型。
 */
const mediaUrl = () =>
  z
    .string()
    .refine(
      (value) => /^asset:\/\/asset_[A-Za-z0-9_-]{8,58}$/.test(value) || /^https:\/\/\S+$/i.test(value),
      "must be an HTTPS URL or asset://<asset ID>"
    );

const flowFields = {
  idempotency_key: generationIdempotencyKeySchema,
  confirmation_token: generationConfirmationTokenSchema,
  confirmed: generationConfirmedSchema,
  why_this_model: generationWhyThisModelSchema,
};

const PRICING =
  "The first call returns a price quote (model, estimated cost, current balance) and a confirmation_token; it starts nothing and charges nothing. " +
  "The job starts on a second call with the same arguments, confirmed: true, the idempotency_key and the confirmation_token, after the user agrees to the quoted price. " +
  "The job is charged to the user's Atlas Cloud balance. A job that fails is usually not charged.";

const INPUT_FILES =
  "Input files are HTTPS URLs, or asset://<asset ID> for a file in the user's Atlas Asset Library.";

const IMAGE_MODELS = "Models: seedream-5.0-pro (Seedream 5.0 Pro, the default), gpt-image-2.5 (GPT Image 2.5), nano-banana-2.1 (Nano Banana 2.1), gpt-image-2 (GPT Image 2).";
const VIDEO_MODELS = "Models: seedance-2.5 (Seedance 2.5, the default), kling-4.0 (Kling 4.0), wan-3.0 (Wan 3.0), seedance-2.0 (Seedance 2.0).";

const imageModelSchema = z
  .enum(IMAGE_MODEL_CHOICES)
  .optional()
  .describe("Image model. Leave it out for seedream-5.0-pro.");
const videoModelSchema = z
  .enum(VIDEO_MODEL_CHOICES)
  .optional()
  .describe("Video model. Leave it out for seedance-2.5.");
const imageAspectSchema = z.enum(IMAGE_ASPECT_RATIOS).optional();
const durationSchema = z
  .number()
  .int()
  .min(4)
  .max(15)
  .optional()
  .describe("Length in seconds, 4 to 15. Default 5.");
const resolutionSchema = z
  .enum(VIDEO_RESOLUTIONS)
  .optional()
  .describe("Output resolution. Default 720p. Kling 4.0 starts at 720p.");
const withAudioSchema = z
  .boolean()
  .optional()
  .describe("Generate a soundtrack with the video. Kling 4.0 has no such setting.");

export const TASK_TOOL_DESCRIPTIONS: Record<TaskToolName, string> = {
  atlas_text_to_image: `Create an image from a text prompt with an image model on Atlas Cloud.

${IMAGE_MODELS}

${PRICING}

Returns a prediction_id; atlas_get_prediction returns the finished image.`,
  atlas_edit_image: `Edit or combine images with a text instruction on Atlas Cloud: change parts of a photo, restyle it, or put products and people from several images into one picture.

${IMAGE_MODELS}

${PRICING}

${INPUT_FILES}

Returns a prediction_id; atlas_get_prediction returns the edited image.`,
  atlas_text_to_video: `Create a video from a text prompt with a video model on Atlas Cloud.

${VIDEO_MODELS}

${PRICING}

Returns a prediction_id; atlas_get_prediction returns the finished video. Videos usually take 1 to 5 minutes.`,
  atlas_image_to_video: `Animate an image into a video on Atlas Cloud: the image is the first frame, and an optional last_image is the last frame. The video keeps the image's aspect ratio.

${VIDEO_MODELS}

${PRICING}

${INPUT_FILES}

Returns a prediction_id; atlas_get_prediction returns the finished video. Videos usually take 1 to 5 minutes.`,
  atlas_reference_to_video: `Create a video on Atlas Cloud that follows reference images, videos or audio: characters, products, scenes, motion or sound taken from the references, described in the prompt.

${VIDEO_MODELS}

${PRICING}

${INPUT_FILES}

Returns a prediction_id; atlas_get_prediction returns the finished video. Videos usually take 1 to 5 minutes.`,
};

const TITLES: Record<TaskToolName, string> = {
  atlas_text_to_image: "Text to Image",
  atlas_edit_image: "Edit Image",
  atlas_text_to_video: "Text to Video",
  atlas_image_to_video: "Image to Video",
  atlas_reference_to_video: "Reference to Video",
};

type FlowArgs = {
  idempotency_key?: string;
  confirmation_token?: string;
  confirmed?: boolean;
  why_this_model?: string;
};

type Built = { ok: true; params: Record<string, unknown> } | { ok: false; message: string };

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

/** 用户没选模型时：按默认路由取线上目录里第一个有这个任务的。 */
async function resolveModelId(tool: TaskToolName, choice: ModelChoice | undefined): Promise<string | { error: string }> {
  if (choice) {
    const id = modelIdFor(choice, tool);
    return id ?? { error: `${CHOICE_ROUTE_NAME[choice]} is not available for ${TITLES[tool].toLowerCase()}.` };
  }
  const { type, task } = TASK_OF_TOOL[tool];
  const found = pickDefaultModel(await getModels(), type, task);
  return found ? found.model : { error: `No ${type.toLowerCase()} model for ${TITLES[tool].toLowerCase()} is available right now. Try again later.` };
}

/** 报价 → 确认 → 提交，和 atlas_generate_image / video 同一套（文字也一样，模型和卡片不用学新说法）。 */
async function runTask(
  tool: TaskToolName,
  args: FlowArgs & { model?: ModelChoice },
  built: Built
): Promise<CallToolResult> {
  if (!built.ok) return failure(built.message);
  const { type } = TASK_OF_TOOL[tool];
  const kind = type === "Image" ? "image" : "video";
  const { idempotency_key, confirmation_token, confirmed } = args;
  try {
    const modelId = await resolveModelId(tool, args.model);
    if (typeof modelId !== "string") return failure(modelId.error);
    const inputs = await libraryInputs(built.params, Boolean(confirmation_token || confirmed));
    if (!inputs.ok) return failure(inputs.message);
    const preparation = await prepareGeneration(modelId, inputs.params, {
      expectedType: type,
      endpoint: type === "Image" ? "/model/generateImage" : "/model/generateVideo",
      typeLabel: kind,
      ...(type === "Video" ? { readInputShapes: true } : {}),
    });
    if (!preparation.ok) return failure(preparation.message);
    const { prepared } = preparation;
    const confirmedRequest = {
      resolved_model: prepared.model.model,
      request_body: replaceUrls(prepared.body, inputs.original),
    };
    const shapes = prepared.inputImages ? { input_images: inputImageSummaries(prepared.inputImages) } : {};

    let spend: SpendDecision | null = null;
    if (!confirmation_token && !confirmed) spend = await evaluateSpend(prepared.body);
    if (spend && !spend.autoSubmit) {
      const balanceLinePromise = quoteBalanceNotice(costEstimate(spend).usd);
      const confirmation = await issueGenerationConfirmation(
        tool,
        idempotency_key ?? randomUUID(),
        confirmedRequest,
        prepared.model.price
      );
      const balanceLine = await balanceLinePromise;
      return {
        structuredContent: {
          ...generationConfirmationStructuredContent(prepared.model, kind, confirmation, costEstimate(spend), prepared.body),
          ...shapes,
        },
        content: [
          {
            type: "text",
            text:
              `Confirmation required — no billable request was submitted and no credits were spent.\n\n` +
              `- **Model**: ${prepared.model.displayName} (\`${prepared.model.model}\`)\n` +
              (type === "Video" ? inputShapeNotice(prepared.inputImages, prepared.body) : "") +
              `${confirmationCostNotice(spend)}\n` +
              `${balanceLine ? `${balanceLine}\n` : ""}` +
              `- **Catalog unit price**: ${formatGenerationPricing(confirmation.pricing)}\n` +
              `${confirmationReuseNotice(confirmation.idempotencyKey, confirmation.confirmationToken)}\n` +
              `${alreadySubmittedLine(confirmation)}` +
              `${confirmationValidityNotice(confirmation.expiresAt)}\n\n` +
              `Show the user this model and the estimated cost above, then stop. Do not call this or any generation tool again until the user explicitly confirms in a new message. After confirmation, call again with unchanged arguments, confirmed: true, the idempotency_key above and the confirmation_token.`,
          },
        ],
      };
    }

    const confirmedKey =
      confirmation_token || confirmed
        ? await resolveConfirmedIdempotencyKey(confirmation_token, tool, idempotency_key, confirmedRequest, prepared.model.price)
        : { idempotencyKey: idempotency_key ?? randomUUID() };
    const submitKey = confirmedKey.idempotencyKey;
    const result = await executeIdempotently(
      tool,
      { idempotency_key: submitKey, ...confirmedRequest },
      submitKey,
      () => submitPreparedGeneration(prepared, submitKey)
    );
    if (!result.ok) return failure(result.message);

    const finished =
      result.outputs.length > 0 ? await completedOutputContent(result.outputs, { profile: currentClientProfile() }) : null;
    const label = type === "Image" ? "Image" : "Video";
    return {
      structuredContent: {
        ...generationStructuredContent(result.predictionId, result.model, kind, prepared.body),
        ...(finished ? { status: "completed" as const, outputs: result.outputs } : {}),
        ...shapes,
      },
      content: [
        {
          type: "text",
          text: finished
            ? `${label} generation completed.\n\n` +
              `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
              (spend ? `${autoSubmitNotice(spend)}\n` : "") +
              `\n` +
              finished.text
            : `${label} generation submitted successfully.\n\n` +
              `- **Model**: ${result.model.displayName} (\`${result.model.model}\`)\n` +
              `- **Prediction ID**: \`${result.predictionId}\`\n` +
              (spend ? `${autoSubmitNotice(spend)}\n` : "") +
              `\n` +
              `The ${kind} is being generated. Use \`atlas_get_prediction\` with this ID to check the result.\n` +
              (type === "Image"
                ? `Image generation usually takes 10-30 seconds.`
                : `Video generation typically takes 1-5 minutes.`),
        },
        ...(finished ? finished.blocks : []),
        ...(confirmedKey.notice ? [{ type: "text" as const, text: confirmedKey.notice }] : []),
      ],
    };
  } catch (error) {
    return failure(handleError(error));
  }
}

function register<Shape extends z.ZodRawShape>(
  server: McpServer,
  tool: TaskToolName,
  inputSchema: Shape,
  build: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Built
): void {
  server.registerTool(
    tool,
    {
      title: TITLES[tool],
      description: TASK_TOOL_DESCRIPTIONS[tool],
      inputSchema,
      outputSchema: generationOutputSchema,
      annotations: { ...TASK_TOOL_POLICIES[tool].annotations },
      ...generationToolCardMeta(),
    },
    // 卡片点 Generate 时用报价里的工具名和参数再调一次这个工具（generation-quote.ts）。
    withGenerationCard(server, tool, async (args: Record<string, unknown>) =>
      runTask(tool, args as FlowArgs & { model?: ModelChoice }, build(args as z.objectOutputType<Shape, z.ZodTypeAny>))
    ) as never
  );
}

/** ChatGPT 专用：5 个任务工具（开关 MCP_CHATGPT_TASK_TOOLS，server.ts 决定给不给）。 */
export function registerChatGptTaskTools(server: McpServer): void {
  register(
    server,
    "atlas_text_to_image",
    {
      ...flowFields,
      prompt: z.string().min(1).max(4000).describe("What the image should show"),
      model: imageModelSchema,
      aspect_ratio: imageAspectSchema.describe("Image shape. Default 1:1."),
    },
    (args) => ({
      ok: true,
      params: imageParams((args.model ?? IMAGE_MODEL_CHOICES[0]) as ImageModelChoice, {
        prompt: args.prompt,
        ...(args.aspect_ratio ? { aspect_ratio: args.aspect_ratio } : {}),
      }),
    })
  );

  register(
    server,
    "atlas_edit_image",
    {
      ...flowFields,
      prompt: z.string().min(1).max(4000).describe("What to change, or how to combine the images"),
      images: z.array(mediaUrl()).min(1).max(10).describe("Images to edit or combine (1 to 10)"),
      model: imageModelSchema,
      aspect_ratio: imageAspectSchema.describe("Output shape. Left out, the model's default size is used."),
    },
    (args) => ({
      ok: true,
      params: imageParams((args.model ?? IMAGE_MODEL_CHOICES[0]) as ImageModelChoice, {
        prompt: args.prompt,
        images: args.images,
        ...(args.aspect_ratio ? { aspect_ratio: args.aspect_ratio } : {}),
      }),
    })
  );

  const video = (args: VideoTaskArgs & { model?: VideoModelChoice }): Built =>
    videoParams(args.model ?? VIDEO_MODEL_CHOICES[0], args);

  register(
    server,
    "atlas_text_to_video",
    {
      ...flowFields,
      prompt: z.string().min(1).max(4000).describe("What happens in the video"),
      model: videoModelSchema,
      duration: durationSchema,
      resolution: resolutionSchema,
      aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).optional().describe("Video shape. Default 16:9."),
      with_audio: withAudioSchema,
    },
    (args) => video(args as VideoTaskArgs & { model?: VideoModelChoice })
  );

  register(
    server,
    "atlas_image_to_video",
    {
      ...flowFields,
      image: mediaUrl().describe("First frame of the video"),
      last_image: mediaUrl().optional().describe("Optional last frame"),
      prompt: z.string().min(1).max(4000).optional().describe("How the scene moves. Wan 3.0 needs it."),
      model: videoModelSchema,
      duration: durationSchema,
      resolution: resolutionSchema,
      with_audio: withAudioSchema,
    },
    (args) => video(args as VideoTaskArgs & { model?: VideoModelChoice })
  );

  register(
    server,
    "atlas_reference_to_video",
    {
      ...flowFields,
      prompt: z.string().min(1).max(4000).describe("The video to make, referring to the inputs (for example: the person in image 1 dances to audio 1)"),
      reference_images: z.array(mediaUrl()).max(9).optional().describe("Reference images (up to 9)"),
      reference_videos: z.array(mediaUrl()).max(3).optional().describe("Reference videos (up to 3)"),
      reference_audios: z.array(mediaUrl()).max(3).optional().describe("Reference audio (up to 3). Kling 4.0 takes none."),
      model: videoModelSchema,
      duration: durationSchema,
      resolution: resolutionSchema,
      aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).optional().describe("Video shape"),
      with_audio: withAudioSchema,
    },
    (args) => {
      const count =
        (args.reference_images?.length ?? 0) + (args.reference_videos?.length ?? 0) + (args.reference_audios?.length ?? 0);
      if (count === 0) {
        return { ok: false, message: "Add at least one reference image, video or audio. For a video from a prompt alone, use atlas_text_to_video." };
      }
      return video(args as VideoTaskArgs & { model?: VideoModelChoice });
    }
  );
}
