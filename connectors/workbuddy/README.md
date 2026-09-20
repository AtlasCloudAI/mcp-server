# WorkBuddy 连接器

面向腾讯 WorkBuddy 开放平台的连接器包。规范见
<https://open.workbuddy.cn/docs/connector>，提交入口 <https://open.workbuddy.cn/connector/publish>。

## 这个目录下有三个彼此独立的上架物料

WorkBuddy 开放平台的连接器、技能、专家是三条各自审核的通道：

| 物料 | 内容 | 位置 | 状态 |
| --- | --- | --- | --- |
| 连接器 | `connector-meta.json` + `mcp.json` + `icon.svg` | 本目录 | 草稿 `oc_630b5b5c9e689e22`，卡在动态注册 |
| 技能 | 每个一个 `SKILL.md` 目录 | `skills/`，用 `打技能包.sh` 单独打 | 可独立提交 |
| 专家 | `.codebuddy-plugin/plugin.json` + `agents/*.md` + 头像 | `expert/`，见该目录 README | 包已就绪，两项待确认 |

专家通过 `dependencies.connectors: ["atlas-cloud"]` 把连接器拉进来用，并打包复用 `skills/` 的三个技能
（打包时复制，不在仓库里存第二份）。

## 当前方案：标准 MCP OAuth（`auth_mode` 省略）

```
connectors/workbuddy/
├── connector-meta.json   必须，不声明 auth_mode = 走标准 MCP OAuth
├── mcp.json              必须，直连生产远程服务
├── icon.svg              必须
└── skills/               三个 skill
```

用户点「连接」→ 桌面端发现 PRM 与授权服务器元数据 → 动态注册客户端 →
浏览器跳 `auth.atlascloud.ai` 授权 → 带 Bearer 调 `https://mcp.atlascloud.ai/mcp`。
**不装本地进程，不发 npm，也不需要和腾讯做任何沟通。**

远程档位暴露 **12 个工具**，比 stdio 少 `atlas_chat` 和 `atlas_upload_media`。

### 唯一卡点：授权服务器要实现动态注册

WorkBuddy 桌面端内置官方 MCP TypeScript SDK 1.24.3。实测其打包代码：`registerClient()` 在
`metadata.registration_endpoint` 缺失时抛 `Incompatible auth server`。

⚠️ **CIMD 通道对它无效，但原因不是「SDK 不支持」** —— SDK 支持（SEP-991，标识符叫
`supportsUrlBasedClientId` / `provider.clientMetadataUrl`，搜 `clientIdMetadataDocument` 会得到
0 命中并让你判错）。走 CIMD 需要两个条件同时成立：服务端声明 `client_id_metadata_document_supported`
（我们已声明），**且**宿主在自己构造的 provider 里传 `clientMetadataUrl`。WorkBuddy 的
`createProvider()` 只传 `redirectUrl`/`clientMetadata`/`clientInformation`/`tokens`，没有
`clientMetadataUrl`，所以恒走动态注册；它还为动态注册做了 leader-follower 协调，说明那是设计主路径。

这不是特例。市场缓存 236 个连接器里 142 个是远程且不自填凭证，抽查五个第三方
（Canva、千图网、八爪鱼、FastMoss、分贝通）授权服务器**全部**提供动态注册端点。
把分贝通和我们逐项对照，差距只有 `registration_endpoint` 一行。

详见 `OAuth改造需求-给后端.md` —— 它既是给后端的说明也是完整规格，含验收命令、对照样板，以及三条无代码路径为何都不成立的记录。

### 走过的弯路

一度判断要走 `auth_mode: server-side` 云端托管 OAuth，理由是平台按连接器下发
`oauth_client_id` / `oauth_redirect_url`。后来发现桌面端把这条路硬限制在
`.mcp.it.woa.com` 等域名加两个内部企业 ID，用例全是腾讯自家产品，对外部开发者不适用。
据此写过一封向腾讯索取回调地址的申请信，已删除 —— 动态注册模式下客户端自带 redirect_uri，
不需要向平台索取任何参数。

## 曾经评估过的备选：用户自填 Token

用 `auth_mode: token` + `npx atlascloud-mcp`，用户粘贴自己的 Atlas API Key，
14 个工具。能上线但与「不用贴 key」的产品主张不一致，且卡在 npm 发布权限
（包 owner 只有 `mikewangatlas`）。已让位给托管 OAuth，配置不再保留在仓库里。

## 技能单独走技能市场

连接器包里的 `skills/` 会随连接器一起装。但连接器要等 npm 那步，技能可以先单独上：
市场 → 技能 tab → 右上角「添加技能」，传 zip。

```bash
./connectors/workbuddy/打技能包.sh          # 输出到 connectors/workbuddy/dist-skills/
```

每个技能一个 zip，顶层是 `{skill-name}/SKILL.md`。官方必填 frontmatter 是
`description`、`description_zh`、`description_en`、`version`、`author`，这五个原先
全缺（skill 是从 Codex 插件仓搬过来的，那边不要求），已补齐。
`category` 官方没给枚举值，字段表里也不是必填，故意没加，免得填错值解析失败。

解析失败时官方让对照「技能基础结构」「子资源目录说明」自查，实在不行发
openworkbuddy@tencent.com 或进开放平台首页的社群。

## 打包提交

```bash
cd connectors/workbuddy && zip -r ../../atlas-cloud-workbuddy.zip \
  connector-meta.json mcp.json icon.svg skills -x '.*' -x '*/.*'
```

限制 20MB，本包约 208KB。上传后平台解包生成连接器 ID，再提交审核，
通过后进连接器市场，后续更新重新提交，通常 10~15 分钟同步生效。

**打包时别用 `-x '*.md'`**，那会把 `skills/*/SKILL.md` 一起排除掉，
包会从 208KB 缩到 34KB，技能全丢。按上面的白名单写法列文件，不要用黑名单。
