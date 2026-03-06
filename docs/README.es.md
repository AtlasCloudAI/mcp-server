# Atlas Cloud MCP Server

Servidor MCP (Model Context Protocol) para [Atlas Cloud](https://www.atlascloud.ai) — plataforma de agregación de APIs de IA que ofrece generación de imágenes, generación de vídeos y modelos LLM.

[English](../README.md) | [中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | Español | [Français](./README.fr.md)

## Características

- **Búsqueda de documentación** — Busca documentos, modelos y referencias API de Atlas Cloud directamente desde tu IDE
- **Descubrimiento de modelos** — Explora más de 80 modelos de IA con precios y capacidades
- **Generación de imágenes** — Genera imágenes con modelos como Seedream, Qwen-Image, Z-Image, etc.
- **Generación de vídeos** — Genera vídeos con modelos como Kling, Vidu, Seedance, Wan, etc.
- **Chat LLM** — Chatea con modelos LLM (formato compatible con OpenAI) incluyendo GPT, DeepSeek, Qwen, GLM, etc.
- **Schema dinámico** — Obtiene automáticamente el schema de parámetros de cada modelo

## Inicio rápido

### Requisitos previos

- Node.js >= 18
- API Key de Atlas Cloud (obtener en [atlascloud.ai](https://www.atlascloud.ai))

### Configuración en Cursor / Claude Desktop

Añade a tu configuración MCP:

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

## Herramientas disponibles

| Herramienta | Descripción |
|-------------|-------------|
| `atlas_search_docs` | Buscar documentación y modelos por palabra clave |
| `atlas_list_models` | Listar todos los modelos (filtrar por tipo: Text/Image/Video) |
| `atlas_get_model_info` | Obtener información detallada del modelo (schema API, parámetros, ejemplos) |
| `atlas_generate_image` | Generar imágenes |
| `atlas_generate_video` | Generar vídeos |
| `atlas_chat` | Chat con LLM (compatible con OpenAI) |
| `atlas_get_prediction` | Consultar estado y resultado de tareas de generación |

## Desarrollo

```bash
npm install
npm run build
npm run dev
```

## Licencia

MIT
