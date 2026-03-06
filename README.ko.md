# Atlas Cloud MCP Server

[Atlas Cloud](https://www.atlascloud.ai)의 MCP(Model Context Protocol) 서버 — 이미지 생성, 비디오 생성, LLM을 제공하는 AI API 통합 플랫폼.

[English](./README.md) | [中文](./README.zh-CN.md) | [日本語](./README.ja.md) | 한국어 | [Español](./README.es.md) | [Français](./README.fr.md)

## 기능

- **문서 검색** — IDE에서 Atlas Cloud 문서, 모델, API 참조를 직접 검색
- **모델 탐색** — 80개 이상의 AI 모델을 가격 및 기능과 함께 목록 표시
- **이미지 생성** — Seedream, Qwen-Image, Z-Image 등의 모델로 이미지 생성
- **비디오 생성** — Kling, Vidu, Seedance, Wan 등의 모델로 비디오 생성
- **LLM 채팅** — GPT, DeepSeek, Qwen, GLM 등 LLM과 대화 (OpenAI 호환 형식)
- **동적 스키마** — 각 모델의 파라미터 스키마를 자동 가져오기

## 빠른 시작

### 사전 요구사항

- Node.js >= 18
- Atlas Cloud API Key ([console.atlascloud.ai](https://console.atlascloud.ai)에서 발급)

### Cursor / Claude Desktop 설정

MCP 설정에 다음을 추가:

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

## 사용 가능한 도구

| 도구 | 설명 |
|------|------|
| `atlas_search_docs` | 키워드로 문서 및 모델 검색 |
| `atlas_list_models` | 전체 모델 목록 (유형 필터 가능: Text/Image/Video) |
| `atlas_get_model_info` | 모델 상세 정보 (API 스키마, 파라미터, 사용 예제) |
| `atlas_generate_image` | 이미지 생성 |
| `atlas_generate_video` | 비디오 생성 |
| `atlas_chat` | LLM 채팅 (OpenAI 호환) |
| `atlas_get_prediction` | 생성 작업 상태 및 결과 확인 |

## 개발

```bash
npm install
npm run build
npm run dev
```

## 라이선스

MIT
