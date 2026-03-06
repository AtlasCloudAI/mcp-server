# Atlas Cloud MCP Server

English | [中文](./docs/README.zh-CN.md) | [日本語](./docs/README.ja.md) | [한국어](./docs/README.ko.md) | [Español](./docs/README.es.md) | [Français](./docs/README.fr.md)

MCP (Model Context Protocol) server for [Atlas Cloud](https://www.atlascloud.ai) — an AI API aggregation platform providing access to image generation, video generation, and LLM models.

## Features

- **Documentation Search** — Search Atlas Cloud docs, models, and API references directly from your IDE
- **Model Discovery** — List and explore 80+ available AI models with pricing and capabilities
- **Image Generation** — Generate images using models like Seedream, Qwen-Image, Z-Image, etc.
- **Video Generation** — Generate videos using models like Kling, Vidu, Seedance, Wan, etc.
- **LLM Chat** — Chat with LLM models (OpenAI-compatible) including GPT, DeepSeek, Qwen, GLM, etc.
- **Dynamic Schema** — Automatically fetches each model's parameter schema for accurate API usage

## Quick Start

### Prerequisites

- Node.js >= 18
- Atlas Cloud API Key (get one at [atlascloud.ai](https://www.atlascloud.ai))

### Configure in Cursor / Claude Desktop

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "atlascloud": {
      "command": "npx",
      "args": ["-y", "atlascloud-mcp-server"],
      "env": {
        "ATLASCLOUD_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Configure in Claude Code

```bash
claude mcp add atlascloud -- npx -y atlascloud-mcp-server
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

### Chat with an LLM

> "Ask DeepSeek V3.2 to explain quantum computing"

The assistant will use `atlas_chat` with the DeepSeek model.

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
