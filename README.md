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
  MCP (Model Context Protocol) server for <a href="https://www.atlascloud.ai">Atlas Cloud</a> — an AI API aggregation platform providing access to image generation, video generation, and LLM models.
</p>

---

## Features

- **Model Discovery** — List and explore 200+ available AI models with pricing and capabilities
- **Image Generation** — Generate images using models like Seedream, Qwen-Image, Flux, Imagen, etc.
- **Video Generation** — Generate videos using models like Kling, Vidu, Seedance, Wan, Hailuo, Veo, etc.
- **LLM Chat** — Chat with LLM models (OpenAI-compatible) including DeepSeek, Qwen, GLM, MiniMax, etc.
- **Media Upload** — Upload local images/media for use with image-editing and image-to-video models
- **Quick Generate** — One-step generation with automatic model search and parameter building
- **Documentation Search** — Search Atlas Cloud docs, models, and API references directly from your IDE
- **Dynamic Schema** — Automatically fetches each model's parameter schema for accurate API usage

## Quick Start

### Prerequisites

- Node.js >= 18
- Atlas Cloud API Key — [Get one free at atlascloud.ai](https://www.atlascloud.ai/console/api-keys)

### Cursor / Claude Desktop

Add to your MCP configuration:

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

### Claude Code

```bash
claude mcp add atlascloud -- npx -y atlascloud-mcp
```

Then set the environment variable `ATLASCLOUD_API_KEY` in your shell.

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

The AI assistant will use `atlas_search_docs` or `atlas_list_models` to find relevant models.

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

## License

MIT
