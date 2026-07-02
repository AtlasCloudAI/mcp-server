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
  <a href="../README.md">English</a> | <a href="./README.zh-CN.md">中文</a> | <a href="./README.ja.md">日本語</a> | <a href="./README.ko.md">한국어</a> | Español | <a href="./README.fr.md">Français</a>
</p>

<p align="center">
  Usa los más de 300 modelos de imagen / vídeo / LLM de <a href="https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server">Atlas Cloud</a> en Claude Code, Codex, Gemini CLI, Cursor, Cline y muchos más. Genera imágenes, vídeos y chatea mediante herramientas MCP estándar.
</p>

<p align="center">
  <a href="https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server"><b>→ Consigue tu API key gratuita de Atlas Cloud</b></a> · más de 300 modelos · compatible con OpenAI
</p>

---

## Modelos compatibles

- 🎬 **Vídeo** — Seedance 2.0 · Kling 3 · Sora 2 · Veo 3.1 · HappyHorse 1 · Grok Imagine 1.5 · Wan 2.7
- 🎨 **Imagen** — Nano Banana 2/Pro · GPT Image 2 · Flux 2 · Seedream 5
- 🧊 **3D** — Hunyuan 3D imagen-a-3D / texto-a-3D
- 💬 **LLM** — Claude · GPT · DeepSeek · MiniMax · Kimi · GLM · Qwen
- 🔊 **Audio (TTS)** — Seed Audio · xAI/Grok TTS · ElevenLabs

- 📚 **Explora más** — [más de 300 modelos »](https://www.atlascloud.ai/models?utm_source=github&utm_campaign=mcp-server)

## Contenido

- [Qué puedes hacer](#qué-puedes-hacer)
- [Inicio rápido](#inicio-rápido)
- [Herramientas disponibles](#herramientas-disponibles)
- [Ejemplos de uso](#ejemplos-de-uso)
- [Desarrollo](#desarrollo)
- [Más herramientas de Atlas Cloud](#más-herramientas-de-atlas-cloud)
- [Licencia](#licencia)

## Qué puedes hacer

Pídeselo a tu asistente de IA en lenguaje natural: él descubre el modelo adecuado, construye los parámetros y envía la tarea:

- 🎨 **"Crea una imagen destacada para esta entrada de blog"** — texto-a-imagen con Nano Banana Pro, GPT Image 2, Flux 2, Seedream, Imagen…
- 🎬 **"Convierte esta foto de producto en un anuncio de 5 segundos"** — imagen-a-vídeo con Kling 3, Seedance 2, Veo 3.1, Sora 2…
- 🧊 **"Crea un modelo 3D a partir de esta foto"** — imagen-a-3D / texto-a-3D con Hunyuan 3D (salida GLB/OBJ/USDZ)
- 🔊 **"Lee este guion en voz alta"** — texto-a-voz con Seed Audio, ElevenLabs, xAI TTS
- 🎞️ **"Convierte este guion en un storyboard de 6 planos"** — encadena LLM → imagen → vídeo dentro de una sola conversación
- ✏️ **"Edita esta imagen — añade un sombrero"** — sube un archivo local y luego ejecuta un modelo de edición de imagen
- 💸 **"¿Cuánto crédito me queda y cuánto he gastado este mes?"** — consulta el saldo, el uso y el desglose de costes
- 💬 **"Resume este PDF con DeepSeek"** — chat LLM compatible con OpenAI con Claude, GPT, DeepSeek, Qwen, GLM…

Por debajo: descubrimiento de modelos, esquemas de parámetros dinámicos por modelo (validados antes de cada solicitud, de modo que los parámetros inválidos fallan de inmediato sin gastar créditos), carga de medios, generación rápida en un paso, saldo y uso de la cuenta, y búsqueda en la documentación, todo expuesto como herramientas MCP estándar (consulta [Herramientas disponibles](#herramientas-disponibles)).

## Inicio rápido

### Requisitos previos

- Node.js >= 18
- API Key de Atlas Cloud — [Consíguela gratis en atlascloud.ai](https://www.atlascloud.ai/console/api-keys?utm_source=github&utm_campaign=mcp-server)

Consulta [`.env.example`](./.env.example) para conocer la variable de entorno que debes configurar.

### Agentes CLI (instalación en una línea)

La vía más rápida: estos agentes de programación con IA añaden el servidor con un solo comando:

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

> Configura primero la variable de entorno `ATLASCLOUD_API_KEY` en tu shell.

### IDEs, editores y extensiones (configuración JSON)

Añade lo siguiente a la configuración MCP de tu cliente — funciona con todos los clientes compatibles con MCP:

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

| Cliente | Dónde añadirlo |
|--------|-----------------|
| [Cursor](https://cursor.com) | Settings → MCP → Add Server |
| [Cline](https://github.com/cline/cline) | MCP Marketplace → Add Server |
| [Continue](https://continue.dev) | `config.yaml` → MCP |
| [Windsurf](https://codeium.com/windsurf) | Settings → MCP → Add Server |
| [VS Code (Copilot)](https://code.visualstudio.com) | `.vscode/mcp.json` o Settings → MCP |
| [Trae](https://trae.ai) | Settings → MCP → Add Server |
| [JetBrains IDEs](https://www.jetbrains.com) | Settings → Tools → AI Assistant → MCP |
| [ChatGPT Desktop](https://openai.com/chatgpt/desktop) | Settings → MCP |
| [Amazon Q Developer](https://aws.amazon.com/q/developer/) | MCP Configuration |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | Settings → MCP → Add Server |

### ¿Prefieres Skills?

Si prefieres usar Skills en lugar de MCP, también ofrecemos un paquete [Atlas Cloud Skills](https://github.com/AtlasCloudAI/atlas-cloud-skills) para Claude Code y otros agentes compatibles con Skills.

## Herramientas disponibles

| Herramienta | Descripción |
|------|-------------|
| `atlas_search_docs` | Buscar en la documentación y los modelos de Atlas Cloud por palabra clave |
| `atlas_list_models` | Listar todos los modelos disponibles, con filtro opcional por tipo (Text/Image/Video/Audio) |
| `atlas_get_model_info` | Obtener información detallada del modelo, incluyendo esquema de la API, parámetros y ejemplos de uso |
| `atlas_generate_image` | Generar imágenes y modelos 3D (imagen-a-3D / texto-a-3D) con cualquier modelo de imagen compatible |
| `atlas_generate_video` | Generar vídeos con cualquier modelo de vídeo compatible |
| `atlas_generate_audio` | Generar audio / voz (TTS) con cualquier modelo de audio compatible |
| `atlas_quick_generate` | Generación de imagen/vídeo/audio en un paso — encuentra el modelo por palabra clave, construye los parámetros y envía |
| `atlas_upload_media` | Subir archivos locales para obtener una URL utilizable con modelos de edición de imagen / imagen-a-vídeo |
| `atlas_chat` | Chatear con modelos LLM (formato compatible con OpenAI) |
| `atlas_get_prediction` | Consultar el estado y el resultado de las tareas de generación de imagen/vídeo/audio/3D |
| `atlas_get_balance` | Obtener el saldo de la cuenta y el resumen de créditos de tu API key |
| `atlas_get_model_usage` | Obtener el uso diario por modelo (solicitudes, tokens, recuentos de imagen/vídeo) en un rango de fechas |
| `atlas_get_model_costs` | Obtener los tramos de coste (gasto) diario por modelo en un rango de fechas |

## Ejemplos de uso

### Buscar modelos

> "Busca en Atlas Cloud modelos de generación de vídeo"

Tu asistente de IA usará `atlas_search_docs` o `atlas_list_models` para encontrar los modelos relevantes.

### Generar una imagen

> "Genera una imagen de un gato en el espacio usando Seedream"

El asistente hará lo siguiente:
1. Usar `atlas_list_models` para encontrar los modelos de imagen Seedream
2. Usar `atlas_get_model_info` para obtener los parámetros del modelo
3. Usar `atlas_generate_image` con los parámetros correctos

### Generar un vídeo

> "Crea un vídeo del lanzamiento de un cohete usando Kling v3"

El asistente hará lo siguiente:
1. Encontrar el modelo de vídeo Kling
2. Obtener su esquema para comprender los parámetros requeridos
3. Usar `atlas_generate_video` con los parámetros adecuados

### Subir una imagen local para editar o generar vídeo

> "Edita esta imagen /Users/me/photos/cat.jpg para añadir un sombrero"

El asistente hará lo siguiente:
1. Usar `atlas_upload_media` para subir el archivo local y obtener una URL
2. Encontrar un modelo de edición de imagen
3. Usar `atlas_generate_image` con la URL subida

> **Nota**: Los archivos subidos son solo para uso temporal con las tareas de generación de Atlas Cloud. Los archivos pueden eliminarse periódicamente. No lo utilices como alojamiento permanente de archivos — el abuso puede provocar la suspensión de la API key.

### Generar voz (TTS)

> "Lee esta frase en voz alta con Seed Audio: Welcome to Atlas Cloud"

El asistente hará lo siguiente:
1. Usar `atlas_list_models` con `type="Audio"` para encontrar el modelo TTS
2. Usar `atlas_generate_audio` con el texto que se va a sintetizar
3. Usar `atlas_get_prediction` para recuperar la URL del audio generado

### Generar un modelo 3D

> "Convierte esta foto de producto en un modelo 3D con Hunyuan 3D"

Los modelos 3D son modelos de tipo Image, por lo que el asistente usa `atlas_generate_image` con el parámetro `image` y recupera un archivo GLB/OBJ/USDZ mediante `atlas_get_prediction`.

### Chatear con un LLM

> "Pídele a Qwen que explique la computación cuántica"

El asistente usará `atlas_chat` con el modelo Qwen.

### Consultar saldo y uso

> "¿Cuánto crédito de Atlas Cloud me queda y cuánto he gastado este mes?"

El asistente usará `atlas_get_balance` para el saldo actual y `atlas_get_model_costs` para el desglose del gasto.

## Desarrollo

```bash
# Instalar dependencias
npm install

# Compilar
npm run build

# Ejecutar en modo desarrollo
npm run dev
```

## Más herramientas de Atlas Cloud

- 🧰 **¿Quieres usarlo desde la terminal?** → [atlascloud-cli](https://github.com/AtlasCloudAI/cli)
- 🤖 **¿Quieres usarlo en Claude Code / Cursor?** → [Atlas Cloud MCP Server](https://github.com/AtlasCloudAI/mcp-server)
- 🎬 **¿Lo quieres como Skill de Claude Code / Codex / Gemini CLI?** → [atlas-cloud-skills](https://github.com/AtlasCloudAI/atlas-cloud-skills)
- 🎨 **Nodos de ComfyUI** → [atlascloud_comfyui](https://github.com/AtlasCloudAI/atlascloud_comfyui)
- 🔁 **Nodos de n8n** → [n8n-nodes-atlascloud](https://github.com/AtlasCloudAI/n8n-nodes-atlascloud)
- 💬 **Únete a nuestro Discord** → [discord.gg/MWmMr4q9es](https://discord.gg/MWmMr4q9es)
- 🌐 **Sitio web** → [atlascloud.ai](https://www.atlascloud.ai?utm_source=github&utm_campaign=mcp-server)

## Licencia

MIT
