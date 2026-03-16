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
  <a href="../README.md">English</a> | 中文 | <a href="./README.ja.md">日本語</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.es.md">Español</a> | <a href="./README.fr.md">Français</a>
</p>

<p align="center">
  <a href="https://www.atlascloud.ai">Atlas Cloud</a> 的 MCP（模型上下文协议）服务器 —— 一站式 AI API 聚合平台，提供图片生成、视频生成和大语言模型服务。
</p>

---

## 功能特性

- **模型发现** — 浏览 300+ 可用 AI 模型，包含价格和能力信息
- **图片生成** — 使用 Seedream、Qwen-Image、Flux、Imagen 等模型生成图片
- **视频生成** — 使用 Kling、Vidu、Seedance、Wan、Hailuo、Veo 等模型生成视频
- **LLM 对话** — 与 DeepSeek、Qwen、GLM、MiniMax 等大语言模型对话（兼容 OpenAI 格式）
- **媒体上传** — 上传本地图片/媒体文件，用于图片编辑和图生视频等场景
- **快速生成** — 一步到位，自动搜索模型并构建参数
- **文档搜索** — 在 IDE 中直接搜索 Atlas Cloud 文档、模型和 API 参考
- **动态 Schema** — 自动获取每个模型的参数定义，确保 API 调用准确

## 快速开始

### 前提条件

- Node.js >= 18
- Atlas Cloud API Key — [免费获取](https://www.atlascloud.ai/console/api-keys)

### Cursor / Claude Desktop

在 MCP 配置中添加：

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

然后在 shell 中设置环境变量 `ATLASCLOUD_API_KEY`。

## 可用工具

| 工具 | 描述 |
|------|------|
| `atlas_search_docs` | 按关键词搜索 Atlas Cloud 文档和模型 |
| `atlas_list_models` | 列出所有可用模型，可按类型过滤（Text/Image/Video） |
| `atlas_get_model_info` | 获取模型详情，包括 API Schema、参数说明和使用示例 |
| `atlas_generate_image` | 使用任意支持的图片模型生成图片 |
| `atlas_generate_video` | 使用任意支持的视频模型生成视频 |
| `atlas_quick_generate` | 一步生成 — 自动按关键词搜索模型、构建参数并提交任务 |
| `atlas_upload_media` | 上传本地文件获取 URL，用于图片编辑/图生视频等模型 |
| `atlas_chat` | 与大语言模型对话（兼容 OpenAI 格式） |
| `atlas_get_prediction` | 查询图片/视频生成任务的状态和结果 |

## 使用示例

### 搜索模型

> "搜索 Atlas Cloud 上的视频生成模型"

### 生成图片

> "用 Seedream 生成一张太空猫的图片"

AI 助手会：
1. 用 `atlas_list_models` 查找 Seedream 图片模型
2. 用 `atlas_get_model_info` 获取模型参数
3. 用 `atlas_generate_image` 配合正确参数生成图片

### 生成视频

> "用 Kling v3 创建一段火箭发射的视频"

### 上传本地图片进行编辑或生成视频

> "帮我把这张图 /Users/me/photos/cat.jpg 加个帽子"

AI 助手会：
1. 用 `atlas_upload_media` 上传本地文件获取 URL
2. 查找图片编辑模型
3. 用 `atlas_generate_image` 配合上传的 URL 进行编辑

> **注意**：上传的文件仅供 Atlas Cloud 生成任务临时使用，文件可能会被定期清理。请勿将此功能用作长期文件存储，滥用可能导致 API Key 被封禁。

### LLM 对话

> "让 Qwen 解释量子计算"

## 开发

```bash
npm install
npm run build
npm run dev
```

## 许可证

MIT
