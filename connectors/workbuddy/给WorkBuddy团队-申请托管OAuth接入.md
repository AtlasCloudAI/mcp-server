# Atlas Cloud 连接器：申请按 `auth_mode: server-side` 接入

我们是 Atlas Cloud（`atlascloud.ai`），正在提交 MCP 连接器 `atlas-cloud`。
希望走**云端托管 OAuth**，让用户点「连接」即用官网账号授权，而不是手填 API Key。

## 我们这边已就绪

远程 MCP 服务已上生产，发现链路完整：

```
https://mcp.atlascloud.ai/mcp
https://mcp.atlascloud.ai/.well-known/oauth-protected-resource
  resource               https://mcp.atlascloud.ai/mcp
  authorization_servers  ["https://auth.atlascloud.ai"]
  scopes_supported       ["tasks:read"]
```

授权服务器 `https://auth.atlascloud.ai`，OAuth 2.1：

| 能力 | 状态 |
|---|---|
| `authorization_endpoint` | `https://auth.atlascloud.ai/authorize` |
| `token_endpoint` | `https://auth.atlascloud.ai/token` |
| PKCE `S256` | 支持 |
| `authorization_code` + `refresh_token` | 支持 |
| 公开客户端 / 机密客户端 | 都支持 |
| 资源指示符（RFC 8707） | 支持 |

## 需要贵方提供的只有一个参数

**回调地址（`oauth_redirect_url`）。** 我们按 OAuth 规范做精确字符串匹配，
所以需要贵方给出准确值，猜不得。

`client_id` 与 `client_secret` **由我们签发**（我们是授权服务提供方），
拿到回调地址后当天发给贵方，贵方填入连接器的 `oauth_client_id` 即可。
是否需要 `client_secret` 请一并告知——公开客户端可以只用 `client_id` 加 PKCE。

另外想确认两件事：

1. `oauth_app_name` 的填写要求
2. **OAuth 应用是在连接器过审后配置，还是草稿阶段就能配？**
   如果草稿阶段可以，我们希望先联调通过再提交审核；如果必须过审后配，
   我们会先提交，并请贵方在审核时知悉授权链路尚未联调。

我们的连接器草稿已在开放平台建好，`source` 是 `atlas-cloud`。

## 为什么不走动态注册

贵方桌面端内置的 MCP SDK 在没有 `registration_endpoint` 时会抛
`Incompatible auth server: does not support dynamic client registration`，
而我们的授权服务器目前只提供预注册与客户端元数据文档两种方式，未开放 RFC 7591 动态注册。

托管模式对双方都更省：我们加一条客户端登记即可，无需为单一接入方新增动态注册端点与存储。

## 连接器信息

| 项 | 值 |
|---|---|
| `source` | `atlas-cloud` |
| 名称 | Atlas Cloud 媒体生成 |
| 能力 | 图片 / 视频 / 音频 / 转写生成，300+ 模型，12 个 MCP 工具 |
| 计费 | 记在用户自己的 Atlas 账户上 |
| 官网 | https://www.atlascloud.ai/ |

## 联系方式

（请产品补充邮箱 / 企微）
