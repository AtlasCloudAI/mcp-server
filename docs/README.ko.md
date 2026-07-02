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
  <a href="../README.md">English</a> | <a href="./README.zh-CN.md">中文</a> | <a href="./README.ja.md">日本語</a> | 한국어 | <a href="./README.es.md">Español</a> | <a href="./README.fr.md">Français</a>
</p>

<p align="center">
  Claude Code, Codex, Gemini CLI, Cursor, Cline 등에서 <a href="https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server">Atlas Cloud</a>의 300개 이상의 이미지 / 비디오 / LLM 모델을 사용하세요. 표준 MCP 도구를 통해 이미지와 비디오를 생성하고 채팅할 수 있습니다.
</p>

<p align="center">
  <a href="https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server"><b>→ 무료 Atlas Cloud API 키 발급받기</b></a> · 300개 이상의 모델 · OpenAI 호환
</p>

---

## 지원 모델

- 🎬 **비디오** — Seedance 2.0 · Kling 3 · Sora 2 · Veo 3.1 · HappyHorse 1 · Grok Imagine 1.5 · Wan 2.7
- 🎨 **이미지** — Nano Banana 2/Pro · GPT Image 2 · Flux 2 · Seedream 5
- 🧊 **3D** — Hunyuan 3D 이미지→3D / 텍스트→3D
- 💬 **LLM** — Claude · GPT · DeepSeek · MiniMax · Kimi · GLM · Qwen
- 🔊 **오디오 (TTS)** — Seed Audio · xAI/Grok TTS · ElevenLabs

- 📚 **더 살펴보기** — [300개 이상의 모델 »](https://www.atlascloud.ai/models?utm_source=github&utm_campaign=mcp-server)

## 목차

- [할 수 있는 일](#할-수-있는-일)
- [빠른 시작](#빠른-시작)
- [사용 가능한 도구](#사용-가능한-도구)
- [사용 예제](#사용-예제)
- [개발](#개발)
- [더 많은 Atlas Cloud 도구](#더-많은-atlas-cloud-도구)
- [라이선스](#라이선스)

## 할 수 있는 일

AI 어시스턴트에게 평범한 말로 요청하기만 하면 됩니다 — 어시스턴트가 알맞은 모델을 찾아내고, 파라미터를 구성하며, 작업을 제출합니다:

- 🎨 **"이 블로그 게시글의 히어로 이미지를 만들어 줘"** — Nano Banana Pro, GPT Image 2, Flux 2, Seedream, Imagen 등으로 텍스트→이미지 생성
- 🎬 **"이 제품 사진을 5초짜리 광고로 만들어 줘"** — Kling 3, Seedance 2, Veo 3.1, Sora 2 등으로 이미지→비디오 생성
- 🧊 **"이 사진으로 3D 모델을 만들어 줘"** — Hunyuan 3D로 이미지→3D / 텍스트→3D 생성 (GLB/OBJ/USDZ 출력)
- 🔊 **"이 스크립트를 소리 내어 읽어 줘"** — Seed Audio, ElevenLabs, xAI TTS로 텍스트→음성 변환
- 🎞️ **"이 스크립트를 6개 숏의 스토리보드로 만들어 줘"** — 하나의 대화 안에서 LLM → 이미지 → 비디오를 연결
- ✏️ **"이 이미지를 편집해서 모자를 추가해 줘"** — 로컬 파일을 업로드한 뒤 이미지 편집 모델 실행
- 💸 **"크레딧이 얼마나 남았고, 이번 달에 얼마를 썼지?"** — 잔액, 사용량, 비용 내역 확인
- 💬 **"이 PDF를 DeepSeek으로 요약해 줘"** — Claude, GPT, DeepSeek, Qwen, GLM 등과 OpenAI 호환 LLM 채팅

내부적으로는 모델 탐색, 모델별 동적 파라미터 스키마(모든 요청 전에 검증되어 잘못된 파라미터는 크레딧을 소모하지 않고 즉시 실패), 미디어 업로드, 원스텝 빠른 생성, 계정 잔액 및 사용량, 문서 검색이 모두 표준 MCP 도구로 제공됩니다([사용 가능한 도구](#사용-가능한-도구) 참조).

## 빠른 시작

### 사전 요구사항

- Node.js >= 18
- Atlas Cloud API Key — [atlascloud.ai에서 무료 발급](https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server)

설정해야 하는 환경 변수는 [`.env.example`](./.env.example)을 참조하세요.

### CLI 에이전트 (한 줄 설치)

가장 빠른 방법입니다 — 이 AI 코딩 에이전트들은 단일 명령으로 서버를 추가합니다:

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

> 먼저 셸에서 `ATLASCLOUD_API_KEY` 환경 변수를 설정하세요.

### IDE, 에디터 및 확장 프로그램 (JSON 설정)

클라이언트의 MCP 설정에 다음을 추가하세요 — MCP를 지원하는 모든 클라이언트에서 동작합니다:

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

| 클라이언트 | 추가 위치 |
|--------|-----------------|
| [Cursor](https://cursor.com) | Settings → MCP → Add Server |
| [Cline](https://github.com/cline/cline) | MCP Marketplace → Add Server |
| [Continue](https://continue.dev) | `config.yaml` → MCP |
| [Windsurf](https://codeium.com/windsurf) | Settings → MCP → Add Server |
| [VS Code (Copilot)](https://code.visualstudio.com) | `.vscode/mcp.json` 또는 Settings → MCP |
| [Trae](https://trae.ai) | Settings → MCP → Add Server |
| [JetBrains IDEs](https://www.jetbrains.com) | Settings → Tools → AI Assistant → MCP |
| [ChatGPT Desktop](https://openai.com/chatgpt/desktop) | Settings → MCP |
| [Amazon Q Developer](https://aws.amazon.com/q/developer/) | MCP Configuration |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | Settings → MCP → Add Server |

### Skills를 선호하시나요?

MCP보다 Skills를 사용하고 싶다면, Claude Code 및 기타 Skills 지원 에이전트를 위한 [Atlas Cloud Skills](https://github.com/AtlasCloudAI/atlas-cloud-skills) 패키지도 제공합니다.

## 사용 가능한 도구

| 도구 | 설명 |
|------|-------------|
| `atlas_search_docs` | 키워드로 Atlas Cloud 문서 및 모델 검색 |
| `atlas_list_models` | 사용 가능한 전체 모델 목록 표시, 유형별 필터 선택 가능 (Text/Image/Video/Audio) |
| `atlas_get_model_info` | API 스키마, 파라미터, 사용 예제를 포함한 모델 상세 정보 조회 |
| `atlas_generate_image` | 지원되는 모든 Image 모델로 이미지 및 3D 모델 생성 (이미지→3D / 텍스트→3D) |
| `atlas_generate_video` | 지원되는 모든 비디오 모델로 비디오 생성 |
| `atlas_generate_audio` | 지원되는 모든 오디오 모델로 오디오 / 음성 생성 (TTS) |
| `atlas_quick_generate` | 원스텝 이미지/비디오/오디오 생성 — 키워드로 모델을 자동으로 찾고, 파라미터를 구성하여 제출 |
| `atlas_upload_media` | 로컬 파일을 업로드하여 이미지 편집 / 이미지→비디오 모델에 사용할 URL 획득 |
| `atlas_chat` | LLM 모델과 채팅 (OpenAI 호환 형식) |
| `atlas_get_prediction` | 이미지/비디오/오디오/3D 생성 작업의 상태 및 결과 확인 |
| `atlas_get_balance` | API 키의 계정 잔액 및 크레딧 요약 조회 |
| `atlas_get_model_usage` | 지정한 기간의 일별 모델 사용량 조회 (요청 수, 토큰, 이미지/비디오 개수) |
| `atlas_get_model_costs` | 지정한 기간의 일별 모델 비용(지출) 구간 조회 |

## 사용 예제

### 모델 검색

> "Atlas Cloud에서 비디오 생성 모델을 검색해 줘"

AI 어시스턴트가 `atlas_search_docs` 또는 `atlas_list_models`를 사용해 관련 모델을 찾습니다.

### 이미지 생성

> "Seedream으로 우주에 있는 고양이 이미지를 생성해 줘"

어시스턴트는 다음을 수행합니다:
1. `atlas_list_models`로 Seedream 이미지 모델을 찾습니다
2. `atlas_get_model_info`로 모델의 파라미터를 가져옵니다
3. 올바른 파라미터로 `atlas_generate_image`를 사용합니다

### 비디오 생성

> "Kling v3로 로켓 발사 비디오를 만들어 줘"

어시스턴트는 다음을 수행합니다:
1. Kling 비디오 모델을 찾습니다
2. 스키마를 가져와 필요한 파라미터를 파악합니다
3. 적절한 파라미터로 `atlas_generate_video`를 사용합니다

### 편집 또는 비디오 생성을 위한 로컬 이미지 업로드

> "이 이미지 /Users/me/photos/cat.jpg를 편집해서 모자를 추가해 줘"

어시스턴트는 다음을 수행합니다:
1. `atlas_upload_media`로 로컬 파일을 업로드하고 URL을 획득합니다
2. 이미지 편집 모델을 찾습니다
3. 업로드된 URL로 `atlas_generate_image`를 사용합니다

> **참고**: 업로드된 파일은 Atlas Cloud 생성 작업에서의 임시 사용만을 위한 것입니다. 파일은 주기적으로 정리될 수 있습니다. 영구적인 파일 호스팅으로 사용하지 마세요 — 남용 시 API 키가 정지될 수 있습니다.

### 음성 생성 (TTS)

> "Seed Audio로 이 문장을 소리 내어 읽어 줘: Welcome to Atlas Cloud"

어시스턴트는 다음을 수행합니다:
1. `type="Audio"`로 `atlas_list_models`를 사용해 TTS 모델을 찾습니다
2. 합성할 텍스트로 `atlas_generate_audio`를 사용합니다
3. `atlas_get_prediction`으로 생성된 오디오 URL을 가져옵니다

### 3D 모델 생성

> "Hunyuan 3D로 이 제품 사진을 3D 모델로 만들어 줘"

3D 모델은 Image 유형 모델이므로, 어시스턴트는 `image` 파라미터와 함께 `atlas_generate_image`를 사용하고 `atlas_get_prediction`으로 GLB/OBJ/USDZ 파일을 가져옵니다.

### LLM과 채팅

> "Qwen에게 양자 컴퓨팅을 설명해 달라고 해 줘"

어시스턴트는 Qwen 모델로 `atlas_chat`을 사용합니다.

### 잔액 및 사용량 확인

> "Atlas Cloud 크레딧이 얼마나 남았고, 이번 달에 얼마를 썼지?"

어시스턴트는 현재 잔액을 위해 `atlas_get_balance`를, 지출 내역을 위해 `atlas_get_model_costs`를 사용합니다.

## 개발

```bash
# 의존성 설치
npm install

# 빌드
npm run build

# 개발 모드로 실행
npm run dev
```

## 더 많은 Atlas Cloud 도구

- 🧰 **터미널에서 사용하고 싶으신가요?** → [atlascloud-cli](https://github.com/AtlasCloudAI/cli)
- 🤖 **Claude Code / Cursor에서 사용하고 싶으신가요?** → [Atlas Cloud MCP Server](https://github.com/AtlasCloudAI/mcp-server)
- 🎬 **Claude Code / Codex / Gemini CLI Skill로 사용하고 싶으신가요?** → [atlas-cloud-skills](https://github.com/AtlasCloudAI/atlas-cloud-skills)
- 🎨 **ComfyUI 노드** → [atlascloud_comfyui](https://github.com/AtlasCloudAI/atlascloud_comfyui)
- 🔁 **n8n 노드** → [n8n-nodes-atlascloud](https://github.com/AtlasCloudAI/n8n-nodes-atlascloud)
- 💬 **Discord 참여하기** → [discord.gg/MWmMr4q9es](https://discord.gg/MWmMr4q9es)
- 🌐 **웹사이트** → [atlascloud.ai](https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server)

## 라이선스

MIT
