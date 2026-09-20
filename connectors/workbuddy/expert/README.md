# Atlas Media Studio — WorkBuddy 专家包

把一句需求做成成片的 AI 媒体制作总监。生成能力来自 Atlas Cloud 连接器（三百多个图像 / 视频 / 语音 / 音乐 / 转写模型）。

## 这是第三个包，别和前两个搞混

WorkBuddy 开放平台有三条彼此独立的上架通道，各自审核：

| 包 | 内容 | 本仓位置 |
| --- | --- | --- |
| 连接器 | `connector-meta.json` + `mcp.json` + `icon.svg` | `../`（草稿 `oc_630b5b5c9e689e22`） |
| 技能 | 单个 `SKILL.md` 目录 | `../skills/`，用 `../打技能包.sh` 单独打 |
| **专家** | **`.codebuddy-plugin/plugin.json` + `agents/*.md` + 头像** | **本目录** |

专家是「人格 + 工作方法」，它通过 `dependencies.connectors` 把连接器拉进来用，**不重复声明 MCP 地址**。

## 结构

```
expert/
├── .codebuddy-plugin/plugin.json   市场展示 + 依赖声明
├── agents/atlas-media-director.md  Agent 定义（运营要的那份 agents.md）
├── avatars/expert.png              512×512 PNG
├── README.md
├── 自检.py                          按开放文档硬规则校验
└── 打专家包.sh                       打 zip（skills 打包时从 ../skills 复制）
```

`skills/` 不在本目录冗余存一份。三个技能的唯一来源是 `../skills/`，打包时复制进来，避免两份 SKILL.md 各自漂移。

## 用法

```bash
python3 自检.py     # 校验
./打专家包.sh        # 产出 ../dist-expert/atlas-media-studio.zip
```

自检覆盖的硬规则：`displayDescription.zh` 必须 40-50 字、`tags` 与 `quickPrompts` 各固定 3 个、
`defaultInitPrompt` 必须与 `quickPrompts` 第一条逐字一致、`plugin` 必须等于 `name`、
`agentName` 必须能在 `agents/` 找到同名 md、agent frontmatter 不得自带 `tools`、
头像必须是 512×512 且小于 500KB、全包不得出现凭据。

## 依赖字段填什么（已从客户端核实）

`dependencies.connectors` 填的是**连接器的裸 id**，不是平台后台那个 `oc_630b5b5c9e689e22`。
依据（WorkBuddy 5.5.6 客户端）：

```js
// expert-dependency-runtime.ts —— 原样读取清单里的字符串当 id
const connectorDependencies = (manifest.dependencies?.connectors ?? [])
  .filter(id => typeof id === "string" && id.trim().length > 0)
  .map(id => ({ type: "connector", id }));

// 状态查询用这个 id 直接查连接器状态表
status: states[dep.id]?.status === "connected" ? "connected" : "disconnected"

// `connector:` 只是运行时 MCP 配置 id 的前缀，不是连接器 id 本身
function toRuntimeMcpConfigId(configId) {
  return configId.startsWith("connector:") ? configId : `connector:${configId}`;
}
```

本机 `~/.workbuddy/connectors-marketplace/connectors/` 缓存的 243 个连接器，目录名就是这个 id
（`tencent-docs`、`58pic-qiantu-ai`、`lexiang`…），和开放文档示例里的写法一致。

所以这里填了 `atlas-cloud`，与 `../connector-meta.json` 的 `source` 同值。
**仍需向运营确认的是**：平台给连接器分配 id 时，取的是不是 `source` 字段。
取错了不会报错，只会在召唤专家时引导卡片指空。

## 审核顺序

声明了连接器依赖，专家过审大概率要等连接器先上架。连接器卡在官网 OIDC 的动态客户端注册
（见 `../OAuth改造需求-给后端.md`），所以专家的上线时间跟着那件事走。

想让专家独立过审，就改成在包根放 `.mcp.json` 自带 MCP 声明（`x-workbuddy.auth.type = "oauth"`）。
代价是用户那边会多出一个「自定义连接器」条目，和官方连接器重复。**默认不这么做** —— 两条路都要
后端先支持动态注册，自带声明并不能提前上线，只是多一份要维护的配置。

## 和文档对不上的地方（按文档写，不按实物写）

对照本机已上架的腾讯自家专家包 `gaokao-advisor`：它的 `tags` 和 `quickPrompts` **各 4 个**，
`displayDescription.zh` 约 65 字，都超出文档写的「固定 3 个」「40-50 字」。说明解析器不卡这两条。
本包仍按文档取 3 个、41 字 —— 第三方走人工审核，照文档写不会被挑。

## 头像

`avatars/expert.png` 是用 Atlas Cloud 自己生成的（`bytedance/seedream-v4.7/text-to-image`，
2048² 生成后居中裁切降采样到 512²）。产品/设计要换成品牌统一的版本，直接替换该文件再跑一次自检即可。
