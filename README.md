<p align="center">
  <img src="https://www.atlascloud.ai/logo.svg" alt="Atlas Cloud" width="80" />
</p>

<h1 align="center">Atlas Cloud MCP Server</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/atlascloud-mcp"><img src="https://img.shields.io/npm/v/atlascloud-mcp.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/atlascloud-mcp"><img src="https://img.shields.io/npm/dm/atlascloud-mcp.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm downloads" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server"><img src="https://img.shields.io/github/license/AtlasCloudAI/mcp-server?style=flat&colorA=18181B&colorB=28CF8D" alt="license" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server"><img src="https://img.shields.io/github/stars/AtlasCloudAI/mcp-server?style=flat&colorA=18181B&colorB=28CF8D" alt="github stars" /></a>
</p>

<p align="center">
  English | <a href="./docs/README.zh-CN.md">中文</a> | <a href="./docs/README.ja.md">日本語</a> | <a href="./docs/README.ko.md">한국어</a> | <a href="./docs/README.es.md">Español</a> | <a href="./docs/README.fr.md">Français</a>
</p>

<p align="center">
  Use <a href="https://www.atlascloud.ai">Atlas Cloud</a>'s 300+ image / video / LLM models in Claude Code, Codex, Gemini CLI, Cursor, Cline and more. Generate images, videos & chat via standard MCP tools.
</p>

<p align="center">
  <a href="https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server"><b>→ Get your free Atlas Cloud API key</b></a> · 300+ models · OpenAI-compatible
</p>

---

## Supported Models

- 🎬 **Video** — Seedance 2.0 · Kling 3 · Sora 2 · Veo 3.1 · HappyHorse 1 · Grok Imagine 1.5 · Wan 2.7
- 🎨 **Image** — Nano Banana 2/Pro · GPT Image 2 · Flux 2 · Seedream 5
- 💬 **LLM** — Claude · GPT · DeepSeek · MiniMax · Kimi · GLM · Qwen
- 🔊 **Audio** — Grok TTS

- 📚 **Explore more** — [300+ models »](https://www.atlascloud.ai/models?utm_source=github&utm_campaign=mcp-server)

## What You Can Do

Ask your AI assistant in plain language — it discovers the right model, builds the parameters, and submits the job:

- 🎨 **"Make a hero image for this blog post"** — text-to-image across Nano Banana Pro, GPT Image 2, Flux 2, Seedream, Imagen…
- 🎬 **"Turn this product photo into a 5-second ad"** — image-to-video with Kling 3, Seedance 2, Veo 3.1, Sora 2…
- 🎞️ **"Storyboard this script into 6 shots"** — chain LLM → image → video inside one conversation
- ✏️ **"Edit this image — add a hat"** — upload a local file, then run an image-editing model
- 💸 **"Which video model is cheapest for a 10s clip?"** — discover models with live pricing & capabilities
- 💬 **"Summarize this PDF with DeepSeek"** — OpenAI-compatible LLM chat with Claude, GPT, DeepSeek, Qwen, GLM…

Under the hood: model discovery, dynamic per-model parameter schemas, media upload, one-step quick-generate, and documentation search — all exposed as standard MCP tools (see [Available Tools](#available-tools)).

## Quick Start

### Prerequisites

- Node.js >= 18
- Atlas Cloud API Key — [Get one free at atlascloud.ai](https://www.atlascloud.ai/console/api-keys)

### CLI agents (one-line install)

The fastest path — these AI coding agents add the server with a single command:

```bash
# Claude Code
claude mcp add atlascloud -- npx -y atlascloud-mcp

# OpenAI Codex CLI
codex mcp add atlascloud -- npx -y atlascloud-mcp

# Gemini CLI
gemini mcp add atlascloud -- npx -y atlascloud-mcp

# Goose CLI
goose mcp add atlascloud -- npx -y atlascloud-mcp
```

> Set the `ATLASCLOUD_API_KEY` environment variable in your shell first.

### IDEs, editors & extensions (JSON config)

Add this to your client's MCP configuration — works with every MCP-compatible client:

```json
{
  "mcpServers": {
    "atlascloud": {
      "command": "npx",
      "args": ["-y", "atlascloud-mcp"],
      "env": {
        "ATLASCLOUD_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

| Client | Where to add it |
|--------|-----------------|
| [Cursor](https://cursor.com) | Settings → MCP → Add Server |
| [Cline](https://github.com/cline/cline) | MCP Marketplace → Add Server |
| [Continue](https://continue.dev) | `config.yaml` → MCP |
| [Windsurf](https://codeium.com/windsurf) | Settings → MCP → Add Server |
| [VS Code (Copilot)](https://code.visualstudio.com) | `.vscode/mcp.json` or Settings → MCP |
| [Trae](https://trae.ai) | Settings → MCP → Add Server |
| [JetBrains IDEs](https://www.jetbrains.com) | Settings → Tools → AI Assistant → MCP |
| [ChatGPT Desktop](https://openai.com/chatgpt/desktop) | Settings → MCP |
| [Amazon Q Developer](https://aws.amazon.com/q/developer/) | MCP Configuration |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | Settings → MCP → Add Server |

### Prefer Skills?

If you'd rather use Skills than MCP, we also ship an [Atlas Cloud Skills](https://github.com/AtlasCloudAI/atlas-cloud-skills) package for Claude Code and other skill-compatible agents.

## Available Tools

| Tool | Description |
|------|-------------|
| `atlas_search_docs` | Search Atlas Cloud documentation and models by keyword |
| `atlas_list_models` | List all available models, optionally filtered by type (Text/Image/Video) |
| `atlas_get_model_info` | Get detailed model info including API schema, parameters, and usage examples |
| `atlas_generate_image` | Generate images with any supported image model |
| `atlas_generate_video` | Generate videos with any supported video model |
| `atlas_quick_generate` | One-step generation — auto-finds model by keyword, builds params, and submits |
| `atlas_upload_media` | Upload local files to get a URL for use with image-edit / image-to-video models |
| `atlas_chat` | Chat with LLM models (OpenAI-compatible format) |
| `atlas_get_prediction` | Check status and result of image/video generation tasks |

## Usage Examples

### Search for models

> "Search Atlas Cloud for video generation models"

Your AI assistant will use `atlas_search_docs` or `atlas_list_models` to find relevant models.

### Generate an image

> "Generate an image of a cat in space using Seedream"

The assistant will:
1. Use `atlas_list_models` to find Seedream image models
2. Use `atlas_get_model_info` to get the model's parameters
3. Use `atlas_generate_image` with the correct parameters

### Generate a video

> "Create a video of a rocket launch using Kling v3"

The assistant will:
1. Find the Kling video model
2. Get its schema to understand required parameters
3. Use `atlas_generate_video` with appropriate parameters

### Upload a local image for editing or video generation

> "Edit this image /Users/me/photos/cat.jpg to add a hat"

The assistant will:
1. Use `atlas_upload_media` to upload the local file and get a URL
2. Find an image-editing model
3. Use `atlas_generate_image` with the uploaded URL

> **Note**: Uploaded files are for temporary use with Atlas Cloud generation tasks only. Files may be cleaned up periodically. Do not use this as permanent file hosting — abuse may result in API key suspension.

### Chat with an LLM

> "Ask Qwen to explain quantum computing"

The assistant will use `atlas_chat` with the Qwen model.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development mode
npm run dev
```

## More Atlas Cloud Tools

- 🧰 **Want to use it from the terminal?** → Install [atlascloud-cli](https://github.com/AtlasCloudAI/cli)
- 🎬 **Want it as a Claude Code / Codex / Gemini CLI Skill?** → Install [atlas-cloud-skills](https://github.com/AtlasCloudAI/atlas-cloud-skills)
- 🎨 **ComfyUI nodes** → [atlascloud_comfyui](https://github.com/AtlasCloudAI/atlascloud_comfyui)
- 🔁 **n8n nodes** → [n8n-nodes-atlascloud](https://github.com/AtlasCloudAI/n8n-nodes-atlascloud)
- 💬 **Join our Discord** → [discord.gg/MWmMr4q9es](https://discord.gg/MWmMr4q9es)
- 🌐 **Website** → [atlascloud.ai](https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server)

## License

MIT
