# WorkBuddy 一键登录：后端要做的事（只有一条配置）

> 结论先行：**不需要实现动态客户端注册。** 只需在官网 OIDC 的客户端配置里
> 增加一条预注册客户端。`registry.go` 本来就支持配置登记的第一方客户端，
> 是配置项不是代码改动。

## 为什么不用做动态注册

WorkBuddy 支持两种 OAuth 接入：

| 模式 | 谁是 OAuth 客户端 | 我方成本 |
|---|---|---|
| 桌面端自行注册（`auth_mode` 省略） | 桌面端，靠 RFC 7591 动态注册 | 要新增注册端点 + 客户端落库 |
| **云端托管（`auth_mode: server-side`）** | **WorkBuddy 服务端，用预注册的 client_id** | **加一条客户端配置** |

我们选后者。证据来自 WorkBuddy 桌面端自身的代码：平台按连接器下发
`oauth_client_id`、`oauth_redirect_url`、`oauth_app_name`
（`GET /console/as/connector/user/`），授权全程走它自己的后端
（`POST /v2/as/connector/oauth/{name}/start`、`GET …/accesstoken`、`POST …/revoke`）。

也就是说这就是一次标准的「注册第三方 OAuth 应用」，和接 GitHub / 微信登录同构。

## 要做的

在官网 OIDC 的客户端配置里加一条：

| 字段 | 值 |
|---|---|
| `client_id` | WorkBuddy 指定（待对方给） |
| `client_secret` | 若对方要求机密客户端则签发；公开客户端则留空 |
| `redirect_uris` | WorkBuddy 的 `oauth_redirect_url`（待对方给，固定 HTTPS 地址） |
| 授权类型 | `authorization_code` + `refresh_token` |
| scope | `tasks:read` |
| 资源 | `https://mcp.atlascloud.ai/mcp` |

代码位置：`AtlasCloudTeam/kubedl`，分支 **master**，
`console/backend/pkg/authzserver/registry.go` 的 `newClientRegistry`
在启动时加载 `config.AuthServerClient` 列表；加一条配置即可，不必改代码。

> ⚠️ 仓库里 `feat/oidc-provider` 分支（`pkg/oidcprovider/`）是 2026-08-18 的未合并旧实现，
> 不是生产代码，别照它改。

## 现状已满足，无需改动

PKCE `S256`、`authorization_code` + `refresh_token`、公开与机密客户端、
资源指示符、HTTPS、OAuth 2.1 错误格式 —— 全部就绪，实测见
`https://auth.atlascloud.ai/.well-known/openid-configuration`。

## 前置依赖

要等 WorkBuddy 团队给出 `oauth_redirect_url` 与 `client_id`。
申请函见同目录 `给WorkBuddy团队-申请托管OAuth接入.md`。

## 验收

对方给了参数、我方加完配置后，在 WorkBuddy 里点「连接」应跳转到
`https://auth.atlascloud.ai/authorize?...`，登录并同意后回跳成功、连接器变为「已连接」。

失败时按错误码分诊：

| 错误 | 含义 |
|---|---|
| `invalid_client` | `client_id` 没登记，或登记的和对方用的不一致 |
| `invalid_redirect_uri` / 直接报错不跳转 | `redirect_uris` 没登记或不是精确匹配 |
| 跳转成功但换令牌失败 | `client_secret` 或认证方式对不上 |
