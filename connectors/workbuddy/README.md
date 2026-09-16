# WorkBuddy 连接器

面向腾讯 WorkBuddy 开放平台的连接器包。规范见
<https://open.workbuddy.cn/docs/connector>，提交入口 <https://open.workbuddy.cn/connector/publish>。

## 当前方案：云端托管 OAuth（`auth_mode: server-side`）

```
connectors/workbuddy/
├── connector-meta.json   必须，auth_mode: server-side
├── mcp.json              必须，直连生产远程服务
├── icon.svg              必须
└── skills/               三个 skill
```

用户点「连接」→ WorkBuddy 服务端用预注册的 `client_id` 发起授权 → 浏览器跳
`auth.atlascloud.ai` 用官网账号登录 → 回跳后 WorkBuddy 持有令牌 →
桌面端带 Bearer 调 `https://mcp.atlascloud.ai/mcp`。**不装任何本地进程，不发 npm。**

远程档位暴露 **12 个工具**，比 stdio 少 `atlas_chat` 和 `atlas_upload_media`。

### 为什么是托管模式而不是动态注册

WorkBuddy 桌面端内置官方 MCP TypeScript SDK 的 OAuth 实现。实测其打包代码：

- `registerClient()` 在 `metadata.registration_endpoint` 缺失时直接抛
  `Incompatible auth server: does not support dynamic client registration`
- 搜不到任何 `clientIdMetadataDocument` 代码路径，即**它的 SDK 版本不支持 CIMD**，
  `client_id_metadata_document_supported` 只作为元数据 schema 的可选字段存在
- 但 `clientInformation()` 有值时**整个跳过注册**

而平台按连接器下发 `oauth_client_id`、`oauth_redirect_url`、`oauth_app_name`
（`GET /console/as/connector/user/`），授权走 WorkBuddy 自己的后端
（`POST /v2/as/connector/oauth/{name}/start` 等）。这条路就是把 `clientInformation()`
喂饱，因此不需要我方实现 RFC 7591。

我方成本从「新增注册端点 + 客户端落库」降到「加一条客户端配置」，
详见 `OAuth改造需求-给后端.md`。

### 前置依赖

要 WorkBuddy 团队给 `oauth_redirect_url` 与 `client_id`，申请函见
`给WorkBuddy团队-申请托管OAuth接入.md`。拿到后后端加一条配置即可。

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
