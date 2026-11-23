/**
 * ChatGPT 上架应用里这三个工具「已发布」的定义原文（description + 参数结构），逐字照抄。
 *
 * 来源：2026-11-23 从 ChatGPT 存的工具副本取的
 * （chatgpt.com/backend-api/aip/connectors/asdk_app_6aa8f97285d08191bc987b06277134b9/actions）。
 * 这是 OpenAI 审核通过、ChatGPT 生产现在正在用的版本；同一天通过的 atlas_generate_audio 和它的唯一区别是
 * 挂了卡片模板。开关 MCP_CHATGPT_LEAN_DESCRIPTIONS=published 时，ChatGPT 拿到的这三个工具就是这份原文
 * 加上卡片模板（_meta 照旧），用来验证「只加卡片模板」能不能过 OpenAI 的自动检查。见 services/chatgpt-lean.ts。
 *
 * 参数结构和当前代码只差说明文字（另有 why_this_model 不出现、idempotency_key / model_keyword 必填、
 * image_url 带 format: uri），都比当前校验更严或是它的子集；ChatGPT 生产现在就按这份结构调用，服务端照常接受。
 * 不要改这里的文字：改一个字就不再是「已发布原文」。
 */
export const CHATGPT_PUBLISHED_TOOLS: Readonly<
  Record<string, { description: string; inputSchema: Record<string, unknown> }>
> = {
  "atlas_generate_image": {
    "description": "Generate an image using Atlas Cloud API. This also covers image-to-3D and text-to-3D models (they are Image-type models that return 3D files such as GLB/OBJ/USDZ).\n\nThis tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.\n\nBilling: every request is quoted before anything runs. Choose the model and parameters yourself from the user's request and the live catalog — do not ask the user to pick a model or name a budget first unless they asked to choose. Then call once, omitting confirmation_token: the server returns the model, the live quote for these exact parameters and an opaque confirmation_token, and spends nothing. Show the user the model and that price in one short message and stop. Only after a new user message explicitly confirms may you call again with unchanged arguments, confirmed: true, the same idempotency_key, and confirmation_token (if the token was lost or mistyped, the server finds the quote from the unchanged arguments). The quote is an estimate: call it spent only once polling returns a successful result; a job that ends in status \"failed\" is not billed. (A deployment can set an auto-submit limit; calls under it run straight away and report the estimate instead of stopping.)\n\nParameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.\n\nIMPORTANT: The \"model\" parameter requires an exact current model ID. If you don't know it, first call atlas_list_models with type=\"Image\". Do NOT guess model IDs.\n\nYou should also use atlas_get_model_info to understand what parameters a specific image model accepts before calling this tool.\n\nInput files: image, video and audio inputs must be public URLs. For a file on the user's machine, upload it first — with atlas_get_upload_url on a hosted connection (POST the bytes to the upload_url it returns and wait for that command to finish) or atlas_upload_media on a local one — then pass the returned url. Do not inline the file as base64 or a data: URI, and do not call the Atlas REST API yourself with curl: this connection already carries the user's credentials, and there is no API key to use.\n\nArgs:\n  - model (string, required): The exact image model ID. Use atlas_list_models to find valid IDs.\n  - params (object, required): Model-specific parameters as a JSON object. Each model has different parameters defined in its schema. Common params include \"prompt\", \"image_size\", \"num_inference_steps\", etc. For image-to-3D models, \"image\" is required. Use atlas_get_model_info to see the full parameter list for your chosen model.\n\nReturns:\n  A prediction ID to check the result with atlas_get_prediction.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "confirmation_token": {
          "description": "Opaque token returned by this tool's quote-only first call. Supply it only after the user explicitly confirms the exact model, validated parameters, and current pricing. Reuse the same idempotency_key and unchanged arguments.",
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "confirmed": {
          "description": "Set to true on the call after the user has explicitly confirmed the quote. Send the confirmation_token too if you have it; if it was lost or mistyped, the server finds the quote from the unchanged arguments.",
          "type": "boolean"
        },
        "idempotency_key": {
          "description": "A UUID that identifies this intentional write. Reuse it only when retrying the exact same request; use a new UUID for a new generation. On the call after a quote, send the idempotency_key shown in the quote. If crypto is unavailable (a JavaScript cell may have none), build a random UUID another way, for example from Math.random; never reuse one for a different generation.",
          "format": "uuid",
          "type": "string"
        },
        "model": {
          "description": "Image model ID",
          "minLength": 1,
          "type": "string"
        },
        "params": {
          "additionalProperties": {},
          "description": "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model.",
          "type": "object"
        }
      },
      "required": [
        "idempotency_key",
        "model",
        "params"
      ],
      "type": "object"
    }
  },
  "atlas_generate_video": {
    "description": "Generate a video using Atlas Cloud API.\n\nThis tool submits the generation request and returns immediately with a prediction ID. Use atlas_get_prediction to check the result later.\n\nBilling: every request is quoted before anything runs. Choose the model and parameters yourself from the user's request and the live catalog — do not ask the user to pick a model or name a budget first unless they asked to choose. Then call once, omitting confirmation_token: the server returns the model, the live quote for these exact parameters and an opaque confirmation_token, and spends nothing. Show the user the model and that price in one short message and stop. Only after a new user message explicitly confirms may you call again with unchanged arguments, confirmed: true, the same idempotency_key, and confirmation_token (if the token was lost or mistyped, the server finds the quote from the unchanged arguments). The quote is an estimate: call it spent only once polling returns a successful result; a job that ends in status \"failed\" is not billed. (A deployment can set an auto-submit limit; calls under it run straight away and report the estimate instead of stopping.)\n\nParameters are validated against the model's schema BEFORE the request is submitted: if a parameter is missing, has the wrong type, or is not accepted, the tool returns a precise error and does NOT spend credits.\n\nIMPORTANT: The \"model\" parameter requires an exact current model ID. If you don't know it, first call atlas_list_models with type=\"Video\". Do NOT guess model IDs.\n\nYou should also use atlas_get_model_info to see the full parameter list and schema for your chosen video model before calling this tool.\n\nInput files: image, video and audio inputs must be public URLs. For a file on the user's machine, upload it first — with atlas_get_upload_url on a hosted connection (POST the bytes to the upload_url it returns and wait for that command to finish) or atlas_upload_media on a local one — then pass the returned url. Do not inline the file as base64 or a data: URI, and do not call the Atlas REST API yourself with curl: this connection already carries the user's credentials, and there is no API key to use.\n\nArgs:\n  - model (string, required): The exact video model ID. Use atlas_list_models to find valid IDs.\n  - params (object, required): Model-specific parameters as a JSON object. Parameters vary by model - use atlas_get_model_info to see available params. Common ones include:\n    - \"prompt\" (string): Text description of the video\n    - \"image_url\" (string): Source image for image-to-video models\n    - \"duration\" (number): Video duration in seconds\n    - \"aspect_ratio\" (string): e.g., \"16:9\", \"9:16\"\n\nReturns:\n  A prediction ID to check the result with atlas_get_prediction. Video generation typically takes 1-5 minutes.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "confirmation_token": {
          "description": "Opaque token returned by this tool's quote-only first call. Supply it only after the user explicitly confirms the exact model, validated parameters, and current pricing. Reuse the same idempotency_key and unchanged arguments.",
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "confirmed": {
          "description": "Set to true on the call after the user has explicitly confirmed the quote. Send the confirmation_token too if you have it; if it was lost or mistyped, the server finds the quote from the unchanged arguments.",
          "type": "boolean"
        },
        "idempotency_key": {
          "description": "A UUID that identifies this intentional write. Reuse it only when retrying the exact same request; use a new UUID for a new generation. On the call after a quote, send the idempotency_key shown in the quote. If crypto is unavailable (a JavaScript cell may have none), build a random UUID another way, for example from Math.random; never reuse one for a different generation.",
          "format": "uuid",
          "type": "string"
        },
        "model": {
          "description": "Video model ID",
          "minLength": 1,
          "type": "string"
        },
        "params": {
          "additionalProperties": {},
          "description": "Model-specific parameters as JSON object. Use atlas_get_model_info to see available parameters for your chosen model.",
          "type": "object"
        }
      },
      "required": [
        "idempotency_key",
        "model",
        "params"
      ],
      "type": "object"
    }
  },
  "atlas_quick_generate": {
    "description": "Two-step image, video, or audio generation - automatically finds exactly one model by keyword, fetches its schema, builds and validates parameters, then returns a quote before any billable submission.\n\nCovers all generation tasks: text-to-image, image editing, 3D (image/text-to-3D), text/image-to-video, lipsync & talking-avatar (video + audio_url), TTS, and music generation.\n\nParameters are validated against the model's schema BEFORE submitting. If extra_params contains fields the model does not accept (or wrong values), the tool returns a precise error and does NOT spend credits.\n\nBilling: every request is quoted before anything runs. Choose the model and parameters yourself from the user's request and the live catalog — do not ask the user to pick a model or name a budget first unless they asked to choose. Then call once, omitting confirmation_token: the server returns the model, the live quote for these exact parameters and an opaque confirmation_token, and spends nothing. Show the user the model and that price in one short message and stop. Only after a new user message explicitly confirms may you call again with unchanged arguments, confirmed: true, the same idempotency_key, and confirmation_token (if the token was lost or mistyped, the server finds the quote from the unchanged arguments). The quote is an estimate: call it spent only once polling returns a successful result; a job that ends in status \"failed\" is not billed. (A deployment can set an auto-submit limit; calls under it run straight away and report the estimate instead of stopping.)\n\nIMPORTANT: If this tool fails to find a model, call atlas_list_models first to get the exact model list, then use atlas_generate_image / atlas_generate_video / atlas_generate_audio with the exact model ID instead. Do NOT invent extra_params - only pass parameters you know the model accepts (check atlas_get_model_info).\n\nThe tool searches for models by keyword matching against model ID, display name, and tags. After getting the prediction ID, use atlas_get_prediction to check the result.\n\nInput files: image, video and audio inputs must be public URLs. For a file on the user's machine, upload it first — with atlas_get_upload_url on a hosted connection (POST the bytes to the upload_url it returns and wait for that command to finish) or atlas_upload_media on a local one — then pass the returned url. Do not inline the file as base64 or a data: URI, and do not call the Atlas REST API yourself with curl: this connection already carries the user's credentials, and there is no API key to use.\n\nArgs:\n  - model_keyword (string, required): Prefer an exact current model ID returned by atlas_list_models; otherwise use a distinctive display-name keyword.\n  - type (string, required): Generation type: \"Image\", \"Video\", or \"Audio\"\n  - prompt (string, required): Text description of what to generate (for TTS, the text to synthesize; for music, the song description)\n  - image_url (string, optional): Source image URL for image-to-video, image editing, image-to-3D, or talking-avatar models\n  - audio_url (string, optional): Source audio URL for lipsync / talking-avatar video models (the speech the character should say) or speech-to-text models\n  - extra_params (object, optional): Additional model-specific parameters to override defaults (e.g., {\"duration\": 10, \"aspect_ratio\": \"16:9\"}). Only include parameters the model's schema accepts.\n\nReturns:\n  A prediction ID to check the result with atlas_get_prediction.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "additionalProperties": false,
      "properties": {
        "audio_url": {
          "description": "Source audio URL for lipsync / talking-avatar video models or speech-to-text models",
          "format": "uri",
          "type": "string"
        },
        "confirmation_token": {
          "description": "Opaque token returned by this tool's quote-only first call. Supply it only after the user explicitly confirms the exact model, validated parameters, and current pricing. Reuse the same idempotency_key and unchanged arguments.",
          "maxLength": 4096,
          "minLength": 1,
          "type": "string"
        },
        "confirmed": {
          "description": "Set to true on the call after the user has explicitly confirmed the quote. Send the confirmation_token too if you have it; if it was lost or mistyped, the server finds the quote from the unchanged arguments.",
          "type": "boolean"
        },
        "extra_params": {
          "additionalProperties": {},
          "description": "Additional model-specific parameters to override defaults. Only include parameters the model's schema accepts.",
          "type": "object"
        },
        "idempotency_key": {
          "description": "A UUID that identifies this intentional write. Reuse it only when retrying the exact same request; use a new UUID for a new generation. On the call after a quote, send the idempotency_key shown in the quote. If crypto is unavailable (a JavaScript cell may have none), build a random UUID another way, for example from Math.random; never reuse one for a different generation.",
          "format": "uuid",
          "type": "string"
        },
        "image_url": {
          "description": "Source image URL for image-to-video, image editing, image-to-3D, or talking-avatar models",
          "format": "uri",
          "type": "string"
        },
        "model_keyword": {
          "description": "Exact current model ID or a distinctive display-name keyword",
          "minLength": 1,
          "type": "string"
        },
        "prompt": {
          "description": "Text description of what to generate",
          "minLength": 1,
          "type": "string"
        },
        "type": {
          "description": "Generation type: Image, Video, or Audio",
          "enum": [
            "Image",
            "Video",
            "Audio"
          ],
          "type": "string"
        }
      },
      "required": [
        "idempotency_key",
        "model_keyword",
        "type",
        "prompt"
      ],
      "type": "object"
    }
  }
};
