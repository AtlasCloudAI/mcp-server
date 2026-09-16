# WorkBuddy 一键登录：官网 OIDC 需要做的改造

> 目标：让用户在腾讯 WorkBuddy 里点「连接」就跳浏览器用 Atlas 账号授权，
> 而不是手动粘贴 API Key。
>
> 改造范围**只在官网生产 OIDC**（`auth.atlascloud.ai`）。MCP server、
> 生产镜像、K8s 清单一律不动。

## 一、为什么现在不行

WorkBuddy 内置的 OAuth 客户端按 **RFC 7591 动态客户端注册**工作，
全自动，没有任何地方能让我们预先填一个 client_id。它的流程是：

```
调 MCP 拿到 401
  → 读 /.well-known/oauth-protected-resource        ← 我方已就绪
  → 读 /.well-known/oauth-authorization-server      ← 我方已就绪
  → POST registration_endpoint 动态注册             ← ❌ 卡在这里
  → 打开浏览器授权
  → 校验 state，用 code_verifier 换 token
  → 带 Bearer 正常调用
```

实测（2026-09-16）：拿任意 client_id 打 `/authorize` 一律
`401 {"error":"invalid_client"}`，因为客户端没登记过，而又没有登记的途径。

## 二、现状盘点

`https://auth.atlascloud.ai/.well-known/openid-configuration`：

| 能力 | 现状 | 是否满足 |
|---|---|---|
| `code_challenge_methods_supported` | `["S256"]` | ✅ |
| `token_endpoint_auth_methods_supported` | 含 `none`（公开客户端） | ✅ |
| `grant_types_supported` | 含 `authorization_code`、`refresh_token` | ✅ |
| `resource_indicators_supported` | `true` | ✅ |
| `client_id_metadata_document_supported` | `true`（CIMD，ChatGPT 走这条） | — |
| **`registration_endpoint`** | **不存在** | ❌ |
| **回调白名单** | 只认 ChatGPT 与 Codex 环回两种形状 | ❌ |
| **边缘网关** | `/reg`、`/healthz`、`/me` 全 404 | ❌ |

第三行的判据：`/healthz` 和 `/me` 是应用里真实存在的路由，在生产同样 404，
而 `/jwks`、`/authorize`、`/token`、`/.well-known/*` 正常 ——
说明 `auth.atlascloud.ai` 外面有一层路径白名单，应用改完不放行照样打不通。

## 三、要做的三件事

### 1. 开放动态客户端注册

**端点路径随意**，不必叫 `/oauth/register`。WorkBuddy 从发现文档里读
`registration_endpoint`，填什么它就打什么。所以只要：

- 在 `/.well-known/openid-configuration` 与
  `/.well-known/oauth-authorization-server` 里公布 `registration_endpoint`
- 该端点接受未鉴权的 `POST`（`initialAccessToken` 不强制）

**请求形状**（WorkBuddy 实际会发的，公开原生客户端）：

```json
{
  "client_name": "WorkBuddy",
  "application_type": "native",
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "redirect_uris": ["workbuddy://workbuddy/mcp/connector%3Aatlas-cloud/oauth/callback"]
}
```

**响应硬要求**：`201` + JSON，**除 `client_id` 外必须原样回显 `redirect_uris`**。
这是 WorkBuddy 文档明写的，不回显它的流程会直接中断。

```json
{
  "client_id": "…",
  "redirect_uris": ["workbuddy://workbuddy/mcp/connector%3Aatlas-cloud/oauth/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

注意 **不要签发 client_secret**，这是公开客户端，安全性靠 PKCE。
注册是未鉴权入口，建议按 IP 限流。

### 2. 回调地址白名单加两种形状

WorkBuddy 优先用私有协议；被拒时**自动回退一次**到环回地址：

```
workbuddy://workbuddy/mcp/connector%3Aatlas-cloud/oauth/callback
http://127.0.0.1:{随机端口}/oauth/callback
```

三个坑：

- `%3A` 是 `:` 的转义。规范要求 redirect_uri **按字符串精确匹配**，
  不要先解码再比，否则匹配不上
- 环回端口每次随机，不能钉死端口号；按「协议 + 主机 + 路径」匹配，端口放开
- 路径是 `/oauth/callback`，和 ChatGPT 的 `/connector/oauth/{id}`、
  Codex 的 `/callback/{12位随机串}` 都不是一个形状，不能复用现有规则

私有协议那条如果实现成本高，只放行环回那条也能跑通（WorkBuddy 会自动回退），
但会多一次失败往返。

### 3. 边缘网关放行注册路径

把 `registration_endpoint` 的路径加进 `auth.atlascloud.ai` 的白名单。

## 四、其余要求，现状已满足，无需改动

- PKCE `S256` 必须支持 —— 已支持
- 授权码一次性、有效期约 10 分钟
- `access_token` 建议 1 小时；`refresh_token` 不少于 30 天，
  过期后 WorkBuddy 会引导用户重新授权
- 全部端点 HTTPS，错误按 OAuth 2.1 标准格式
- `token_endpoint` 要接受 `token_endpoint_auth_method: none` 的公开客户端

## 五、验收命令（改完照着跑，三条全过即可）

```bash
# 1. 发现文档公布了注册端点
curl -s https://auth.atlascloud.ai/.well-known/oauth-authorization-server \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("registration_endpoint") or "❌ 仍未公布")'

# 2. 动态注册能过，且回显了 redirect_uris
REG=$(curl -s https://auth.atlascloud.ai/.well-known/oauth-authorization-server \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["registration_endpoint"])')
curl -s -X POST "$REG" -H 'Content-Type: application/json' -d '{
  "client_name":"WorkBuddy",
  "application_type":"native",
  "token_endpoint_auth_method":"none",
  "grant_types":["authorization_code","refresh_token"],
  "response_types":["code"],
  "redirect_uris":["workbuddy://workbuddy/mcp/connector%3Aatlas-cloud/oauth/callback"]
}' | python3 -m json.tool
# 期望：有 client_id，且 redirect_uris 原样回显；没有 client_secret

# 3. 拿注册回来的 client_id 走授权端点，不再是 invalid_client
#    把 <CLIENT_ID> 换成上一步的值
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://auth.atlascloud.ai/authorize?client_id=<CLIENT_ID>&response_type=code\
&redirect_uri=workbuddy%3A%2F%2Fworkbuddy%2Fmcp%2Fconnector%253Aatlas-cloud%2Foauth%2Fcallback\
&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&scope=tasks%3Aread"
# 期望：302 跳登录页（现在是 401 invalid_client）
```

## 六、我方已就绪的部分

MCP server 侧不用任何改动，发现链路已经通：

```
https://mcp.atlascloud.ai/.well-known/oauth-protected-resource
  resource               https://mcp.atlascloud.ai/mcp
  authorization_servers  ["https://auth.atlascloud.ai"]
  scopes_supported       ["tasks:read"]
```

拿到用户令牌后，MCP server 用 RFC 8693 令牌交换换成面向 API 的令牌，
这条链路生产已跑通（Codex 就在用），与本次改造无关。

## 七、不做的替代路线

WorkBuddy 也支持 `auth_mode: server-side` / `gateway`，由它云端托管 OAuth，
我方不用改 OIDC，但要和腾讯 WorkBuddy 团队谈接入 —— 商务路径不是技术路径。

再退一步是现方案：用户自填 Atlas API Key（`auth_mode: token`），能上线，
但与「不用贴 key」的产品主张不一致。

另需注意：按 WorkBuddy 规矩，同一服务若同时提供 OAuth 与 Token 两种方式，
**必须用两个不同的 `source` 分别提交**，算两个独立连接器。

## 参考

- WorkBuddy 连接器规范：https://open.workbuddy.cn/docs/connector （见「MCP OAuth 流程」一节）
- RFC 7591 动态客户端注册：https://www.rfc-editor.org/rfc/rfc7591
