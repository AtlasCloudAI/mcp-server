# Atlas Cloud MCP Server

[Atlas Cloud](https://www.atlascloud.ai) 的 MCP（模型上下文协议）服务器 —— 一站式 AI API 聚合平台，提供图片生成、视频生成和大语言模型服务。

[English](../README.md) | 中文 | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md)

## 功能特性

- **文档搜索** — 在 IDE 中直接搜索 Atlas Cloud 文档、模型和 API 参考
- **模型发现** — 浏览 80+ 可用 AI 模型，包含价格和能力信息
- **图片生成** — 使用 Seedream、Qwen-Image、Z-Image 等模型生成图片
- **视频生成** — 使用 Kling、Vidu、Seedance、Wan 等模型生成视频
- **LLM 对话** — 与 GPT、DeepSeek、Qwen、GLM 等大语言模型对话（兼容 OpenAI 格式）
- **动态 Schema** — 自动获取每个模型的参数定义，确保 API 调用准确

## 快速开始

### 前提条件

- Node.js >= 18
- Atlas Cloud API Key（在 [atlascloud.ai](https://www.atlascloud.ai) 获取）

### 在 Cursor / Claude Desktop 中配置

在 MCP 配置中添加：

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

### 在 Claude Code 中配置

```bash
claude mcp add atlascloud -- npx -y atlascloud-mcp-server
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

### LLM 对话

> "让 DeepSeek V3.2 解释量子计算"

## 开发

```bash
npm install
npm run build
npm run dev
```

## 许可证

MIT
