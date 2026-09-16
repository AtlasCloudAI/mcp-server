# 让 WorkBuddy 用「一键登录」而不是让用户贴 API Key —— 需要官网 OIDC 做三件事

## 背景一句话

WorkBuddy（腾讯）的连接器要接 Atlas Cloud。它内置的 OAuth 客户端走的是
**RFC 7591 动态客户端注册**，而 `auth.atlascloud.ai` 现在不提供注册端点，
所以这条路走不通，只能退化成让用户自己填 API Key。

改造点全在官网 OIDC，MCP server 这边一行代码都不用动。

## 现状实测（2026-09-16）

`https://auth.atlascloud.ai/.well-known/openid-configuration` 返回 17 个字段：

| 项 | 现状 | WorkBuddy 要求 | 差距 |
|---|---|---|---|
| `code_challenge_methods_supported` | `["S256"]` | S256 | ✅ 已满足 |
| `token_endpoint_auth_methods_supported` | 含 `none` | 公开客户端，无 client_secret | ✅ 已满足 |
| `grant_types_supported` | 含 `authorization_code`、`refresh_token` | 两者都要 | ✅ 已满足 |
| `registration_endpoint` | **没有** | 必须有 | ❌ 缺 |
| 回调地址白名单 | 只认 ChatGPT 与 Codex 环回两种形状 | 见下 | ❌ 缺 |
| 边缘网关路径 | `/reg`、`/healthz`、`/me` 全 404 | 注册路径要能到达 | ❌ 缺 |

第三项的判据：`/healthz` 和 `/me` 是应用里真实存在的路由，在生产同样 404，
说明这些 404 来自边缘的路径白名单，不是应用本身。

## 要做的三件事

### 1. 开放动态客户端注册（RFC 7591）

- 在发现文档里公布 `registration_endpoint`
- `POST` 该端点要接受**公开客户端**（`token_endpoint_auth_method: "none"`）
- 响应体除 `client_id` 外**必须原样回显 `redirect_uris`**，否则 WorkBuddy
  后续流程直接中断（这是它文档明写的硬要求）
- 建议加限流，注册是未鉴权入口

### 2. 回调地址白名单加两种形状

WorkBuddy 优先用私有协议回调，被拒时会自动回退一次到环回地址：

```
workbuddy://workbuddy/mcp/connector%3Aatlas-cloud/oauth/callback
http://127.0.0.1:{随机端口}/oauth/callback
```

注意三点：
- `%3A` 是 `:` 的转义，要按字符串**精确匹配**，不要自作主张解码
- 环回端口是随机的，不能钉死端口号
- 路径是 `/oauth/callback`，和 Codex 那套 `/callback/{12位随机串}` 不是一个形状

### 3. 边缘网关放行注册路径

把注册端点的路径加进 `auth.atlascloud.ai` 的白名单，否则应用改完了外面照样 404。

## 其余要求现状已满足

- access_token 建议 1 小时、refresh_token 不少于 30 天
- 授权码一次性、约 10 分钟有效
- 全部端点 HTTPS
- OAuth 2.1 标准错误格式

## 不做这个的替代路线

WorkBuddy 还支持 `auth_mode: server-side` / `gateway`，由它云端托管 OAuth，
我们不用改 OIDC，但要和腾讯 WorkBuddy 团队谈接入。这是商务路径不是技术路径。

再退一步就是现在的方案：用户自己填 Atlas API Key（`auth_mode: token`），
能上线，但和 Codex 那边「不用贴 key」的卖点不一致。

## 参考

- WorkBuddy 连接器规范：https://open.workbuddy.cn/docs/connector
- 该页「MCP OAuth 流程」一节列了它对服务端的全部要求
