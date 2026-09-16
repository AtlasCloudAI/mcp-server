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

## 需要贵方提供

1. **回调地址**（`oauth_redirect_url`）——我们登记到白名单后授权才会成功
2. 希望使用的 **`client_id`**，以及是否需要我们签发 `client_secret`
3. `oauth_app_name` 的填写要求

拿到 1、2 之后我们当天就能完成客户端登记。

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
