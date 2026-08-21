<p align="center">
  <img src="https://www.atlascloud.ai/logo.svg" alt="Atlas Cloud" width="80" />
</p>

<h1 align="center">Atlas Cloud MCP Server</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/atlascloud-mcp"><img src="https://img.shields.io/npm/v/atlascloud-mcp.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/atlascloud-mcp"><img src="https://img.shields.io/npm/dm/atlascloud-mcp.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="npm downloads" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server"><img src="https://img.shields.io/github/license/AtlasCloudAI/mcp-server?style=flat&colorA=18181B&colorB=28CF8D" alt="license" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server"><img src="https://img.shields.io/github/stars/AtlasCloudAI/mcp-server?style=flat&colorA=18181B&colorB=28CF8D" alt="github stars" /></a>
  <a href="https://github.com/AtlasCloudAI/mcp-server/pulls"><img src="https://img.shields.io/badge/PRs-welcome-28CF8D.svg?style=flat&colorA=18181B&colorB=28CF8D" alt="PRs Welcome" /></a>
</p>

<p align="center">
  <a href="../README.md">English</a> | 中文 | <a href="./README.ja.md">日本語</a> | <a href="./README.ko.md">한국어</a> | <a href="./README.es.md">Español</a> | <a href="./README.fr.md">Français</a>
</p>

<p align="center">
  在 Claude Code、Codex、Gemini CLI、Cursor、Cline 等工具中使用 <a href="https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server">Atlas Cloud</a> 的 300+ 图片 / 视频 / 大语言模型。通过标准 MCP 工具生成图片、视频，并进行对话。
</p>

<p align="center">
  <a href="https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server"><b>→ 免费获取你的 Atlas Cloud API Key</b></a> · 300+ 模型 · 兼容 OpenAI
</p>

---

## 支持的模型

<!-- ATLAS-MODELS:START lang=zh-CN campaign=mcp-server -->
<!-- ⚠️ Auto-generated from the live model catalog by AtlasCloudAI/.github/scripts/update-models-readme.mjs — do not edit by hand. -->
- 🎬 **视频** (174) — Seedance 2.5 · MiniMax H3 · Youchuan V8.2 · Seedance 2.0 Mini · HappyHorse-1.1 · Gemini Omni Flash
- 🎨 **图片** (118) — Grok Imagine Image 2.0 · Qwen Image 3.0 Pro · Seedream v5.0 Pro · Qwen Image 3.0
- 🧊 **3D** (7) — Seed3D 2.0 · Hunyuan 3D Rapid · Hunyuan 3D Pro · Tripo H3.1
- 💬 **大语言模型** (65) — Grok 4.6 · DeepSeek V4 Pro 0813 · DeepSeek V4 Flash 0731 · Qwen3.8 Max
- 🔊 **音频（TTS · 音乐 · 语音识别）** (17) — Suno chirp-v4-5-all · Suno chirp-v4-5-plus · Suno chirp-auk · Suno chirp-fenix

- 📚 **探索更多** — [全部 400 个在线模型 »](https://www.atlascloud.ai/models?utm_source=github&utm_campaign=mcp-server)
<!-- ATLAS-MODELS:END -->

> 🎬 **最新视频模型** — Seedance 2.5 · Kling 4.0 · Wan 3.0 · Kling Video O3。


## 目录

- [你可以做什么](#你可以做什么)
- [快速开始](#快速开始)
- [可用工具](#可用工具)
- [使用示例](#使用示例)
- [开发](#开发)
- [更多 Atlas Cloud 工具](#更多-atlas-cloud-工具)
- [许可证](#许可证)

## 你可以做什么

用日常语言向你的 AI 助手提出需求 —— 它会自动找到合适的模型、构建参数并提交任务：

- 🎨 **“为这篇博客文章做一张主视觉图”** — 在 Nano Banana Pro、GPT Image 2、Flux 2、Seedream、Imagen 等模型间进行文生图……
- 🎬 **“把这张产品照片做成一段 5 秒的广告”** — 用 Seedance 2.5、Kling 3、Kling Video O3、Veo 3.1 等模型进行图生视频……
- 🧊 **“用这张照片做一个 3D 模型”** — 用 Hunyuan 3D 进行图生 3D / 文生 3D（输出 GLB/OBJ/USDZ）
- 🔊 **“把这段脚本朗读出来”** — 用 Seed Audio、ElevenLabs、xAI TTS 进行文本转语音
- 🎵 **“给我的应用写首主题曲”** — 用 Suno、MiniMax Music 生成音乐
- 📝 **“把这段会议录音转成文字”** — 用 Seed ASR、xAI STT 语音识别
- 🎞️ **“把这段脚本分镜成 6 个镜头”** — 在一次对话中串联 大语言模型 → 图片 → 视频
- ✏️ **“编辑这张图 —— 加一顶帽子”** — 上传本地文件，然后运行图片编辑模型
- 💸 **“还剩多少额度，这个月花了多少？”** — 查询余额、用量和费用明细
- 💬 **“用 DeepSeek 总结这份 PDF”** — 与 Claude、GPT、DeepSeek、Qwen、GLM 等模型进行兼容 OpenAI 的对话……

底层能力包括：模型发现、每个模型的动态参数 Schema（在每次请求前校验，无效参数会快速失败而不消耗额度）、媒体上传、一步式快速生成、账户余额与用量查询、以及文档搜索 —— 全部以标准 MCP 工具的形式提供（详见 [可用工具](#可用工具)）。

## 快速开始

### 前提条件

- Node.js >= 18
- Atlas Cloud API Key — [在 atlascloud.ai 免费获取](https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server)

需要设置的环境变量请参见 [`.env.example`](./.env.example)。

### 命令行 AI 代理（一行命令安装）

最快捷的方式 —— 这些 AI 编码代理只需一条命令即可添加服务器：

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

> 请先在你的 shell 中设置 `ATLASCLOUD_API_KEY` 环境变量。

### IDE、编辑器与扩展（JSON 配置）

将以下内容添加到你客户端的 MCP 配置中 —— 适用于所有兼容 MCP 的客户端：

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

| 客户端 | 配置位置 |
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

### 更喜欢用 Skills？

如果你更倾向于使用 Skills 而非 MCP，我们也为 Claude Code 及其他兼容 Skills 的代理提供了 [Atlas Cloud Skills](https://github.com/AtlasCloudAI/atlas-cloud-skills) 包。

## 可用工具

| 工具 | 描述 |
|------|-------------|
| `atlas_search_docs` | 按关键词搜索 Atlas Cloud 文档和模型 |
| `atlas_list_models` | 列出所有可用模型，可按类型过滤（Text/Image/Video/Audio） |
| `atlas_get_model_info` | 获取模型详情，包括 API Schema、参数说明和使用示例 |
| `atlas_generate_image` | 使用任意支持的图片模型生成图片和 3D 模型（图生 3D / 文生 3D） |
| `atlas_generate_video` | 使用任意支持的视频模型生成视频 |
| `atlas_generate_audio` | 生成音频 — 语音（TTS）与音乐/歌曲（Suno、MiniMax Music） |
| `atlas_transcribe_audio` | 语音转文字（ASR）— 会议、访谈、语音笔记转写 |
| `atlas_quick_generate` | 一步生成图片/视频/音频 —— 按关键词自动查找模型、构建参数并提交 |
| `atlas_upload_media` | 上传本地文件获取 URL，用于图片编辑 / 图生视频等模型 |
| `atlas_chat` | 与大语言模型对话（兼容 OpenAI 格式） |
| `atlas_get_prediction` | 查询图片/视频/音频/3D 生成任务的状态和结果 |
| `atlas_get_balance` | 查询你的 API Key 对应账户余额与额度概览 |
| `atlas_get_model_usage` | 查询某时间范围内每日的模型用量（请求数、token、图片/视频数量） |
| `atlas_get_model_costs` | 查询某时间范围内每日的模型费用（支出）分布 |

## 使用示例

### 搜索模型

> “搜索 Atlas Cloud 上的视频生成模型”

你的 AI 助手会使用 `atlas_search_docs` 或 `atlas_list_models` 查找相关模型。

### 生成图片

> “用 Seedream 生成一张太空猫的图片”

AI 助手会：
1. 用 `atlas_list_models` 查找 Seedream 图片模型
2. 用 `atlas_get_model_info` 获取模型参数
3. 用 `atlas_generate_image` 配合正确参数生成图片

### 生成视频

> “用 Kling v3 创建一段火箭发射的视频”

AI 助手会：
1. 查找 Kling 视频模型
2. 获取其 Schema 以了解所需参数
3. 用 `atlas_generate_video` 配合合适的参数生成视频

### 上传本地图片进行编辑或生成视频

> “帮我把这张图 /Users/me/photos/cat.jpg 加个帽子”

AI 助手会：
1. 用 `atlas_upload_media` 上传本地文件获取 URL
2. 查找图片编辑模型
3. 用 `atlas_generate_image` 配合上传的 URL 进行编辑

> **注意**：上传的文件仅供 Atlas Cloud 生成任务临时使用，文件可能会被定期清理。请勿将此功能用作长期文件存储，滥用可能导致 API Key 被封禁。

### 生成语音（TTS）

> “用 Seed Audio 把这句话朗读出来：Welcome to Atlas Cloud”

AI 助手会：
1. 用 `atlas_list_models` 配合 `type="Audio"` 查找 TTS 模型
2. 用 `atlas_generate_audio` 合成指定文本
3. 用 `atlas_get_prediction` 获取生成的音频 URL

### 生成音乐

> “用 Suno 给我的产品 demo 做一段 30 秒的欢快合成器音乐”

音乐模型（Suno Chirp、MiniMax Music）属于 Audio 类型模型，助手会用 `atlas_generate_audio` 传入歌曲描述（可选歌词），再通过 `atlas_get_prediction` 获取音频 URL。

### 转写音频（语音转文字）

> “转写这段访谈录音：https://example.com/interview.mp3”

助手会用 `atlas_transcribe_audio` 配合语音识别模型（如 `bytedance/seed-asr-2.0`）和 `audio_url`，再通过 `atlas_get_prediction` 获取文字稿。本地文件先用 `atlas_upload_media` 拿到 URL。

### 生成 3D 模型

> “用 Hunyuan 3D 把这张产品照片做成一个 3D 模型”

3D 模型属于 Image 类型模型，因此 AI 助手会使用 `atlas_generate_image` 并传入 `image` 参数，再通过 `atlas_get_prediction` 获取 GLB/OBJ/USDZ 文件。

### 与大语言模型对话

> “让 Qwen 解释量子计算”

AI 助手会使用 `atlas_chat` 调用 Qwen 模型。

### 查询余额与用量

> “我的 Atlas Cloud 还剩多少额度，这个月花了多少？”

AI 助手会用 `atlas_get_balance` 查询当前余额，用 `atlas_get_model_costs` 查询支出明细。

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 以开发模式运行
npm run dev
```

## 更多 Atlas Cloud 工具

- 🧰 **想在终端里使用？** → [atlascloud-cli](https://github.com/AtlasCloudAI/cli)
- 🤖 **想在 Claude Code / Cursor 里使用？** → [Atlas Cloud MCP Server](https://github.com/AtlasCloudAI/mcp-server)
- 🎬 **想作为 Claude Code / Codex / Gemini CLI 的 Skill 使用？** → [atlas-cloud-skills](https://github.com/AtlasCloudAI/atlas-cloud-skills)
- 🎨 **ComfyUI 节点** → [atlascloud_comfyui](https://github.com/AtlasCloudAI/atlascloud_comfyui)
- 🔁 **n8n 节点** → [n8n-nodes-atlascloud](https://github.com/AtlasCloudAI/n8n-nodes-atlascloud)
- 💬 **加入我们的 Discord** → [discord.gg/MWmMr4q9es](https://discord.gg/MWmMr4q9es)
- 🌐 **官网** → [atlascloud.ai](https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server)

## 许可证

MIT
