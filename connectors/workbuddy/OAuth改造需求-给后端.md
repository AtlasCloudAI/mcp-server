# WorkBuddy 一键登录：官网 OIDC 要加动态客户端注册

> 结论先行：**要实现 RFC 7591 动态客户端注册，以及它必需的客户端存储。**
> 这是 WorkBuddy 上第三方连接器的标准做法，不是为我们一家开的特例。
> 协议能力（PKCE、授权码、刷新令牌、公开客户端）已经全部就绪，缺的是注册这条路。
>
> **工作量不是「加个 handler」**：注册出来的客户端要落库、跨副本可见、
> 在 refresh_token 有效期内一直可用，这部分是主体。

## 一、证据：友商都是这么做的

WorkBuddy 连接器市场本机缓存 236 个连接器，其中 **142 个是远程服务且不让用户填凭证**，
它们只能靠 OAuth。抽查五个第三方，授权服务器**全部**提供动态注册端点：

| 连接器 | `registration_endpoint` |
|---|---|
| Canva | `https://mcp.canva.cn/register` |
| 千图网 58pic | `https://ai.58pic.com/oauth/register` |
| 八爪鱼 | `https://identity.bazhuayu.com/connect/register` |
| FastMoss | `https://mcp.fastmoss.com/oauth/register` |
| 分贝通 | `https://mcp.fenbeitong.com/register` |

原因在 WorkBuddy 桌面端代码里：它内置官方 MCP TypeScript SDK，
`registerClient()` 在 `metadata.registration_endpoint` 缺失时直接抛
`Incompatible auth server: does not support dynamic client registration`，
且该 SDK 版本**不实现**客户端元数据文档（CIMD），搜不到任何 `clientIdMetadataDocument` 代码路径。

> 另有一条「云端托管 OAuth」(`auth_mode: server-side`)，但桌面端把它硬限制在
> `.mcp.it.woa.com` / `.mcp.woa.com` / `.knot.woa.com` 域名加两个内部企业 ID，
> 观察到的用例全是腾讯自家产品（ima、乐享、ardot）。对外部开发者不适用。

## 二、差距只有一行

拿分贝通的授权服务器和我们逐项对照：

| 字段 | 分贝通 | auth.atlascloud.ai |
|---|---|---|
| `code_challenge_methods_supported` | `["S256"]` | `["S256"]` ✅ |
| `grant_types_supported` | `authorization_code` + `refresh_token` | 同 ✅ |
| `token_endpoint_auth_methods_supported` | 含 `none` | 含 `none` ✅ |
| **`registration_endpoint`** | **有** | **无** ❌ |

## 三、要做的

### 1. 实现并公布动态注册端点

端点路径随意，WorkBuddy 从发现文档读 `registration_endpoint`，现有端点一个都不用改名。

- `metadata.go` 的 `Metadata` 结构加字段，并在 `Metadata()` 里填值
- `oidc.go` 挂一个未鉴权的 `POST` 路由（`initialAccessToken` 不强制）
- 建议按 IP 限流，`ratelimit.go` 有现成设施

请求（WorkBuddy 会发的，公开原生客户端）：

```json
{
  "client_name": "WorkBuddy",
  "application_type": "native",
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "redirect_uris": ["<客户端自己生成的回调地址>"]
}
```

响应：`201` + JSON，**除 `client_id` 外必须原样回显 `redirect_uris`**，
这是 WorkBuddy 文档明写的硬要求。**不要签发 `client_secret`**，公开客户端靠 PKCE。

> 注意：回调地址由客户端在注册时自己提交，**我方不需要事先知道也不需要向腾讯索取**。
> 这正是动态注册存在的意义。

### 2. `clientRegistry` 加第三个来源

`registry.go` 现在两个来源：配置登记的第一方（启动全量加载）+ 元数据文档 URL 标识的第三方（按需 fetch）。
动态注册产生的客户端是第三种，需落库并在多副本间共享，`Lookup` 走 DB 那一路。

### 3. 边缘网关放行注册路径

`auth.atlascloud.ai` 外面有一层路径白名单。判据：`/healthz`、`/me` 是应用里真实存在的路由，
在生产同样 404，而 `/jwks`、`/authorize`、`/token` 正常。

## 四、明确不用做的

| 项 | 为什么 |
|---|---|
| 支持公开客户端 | 已支持，`registry.go` 有 `Public` 标志 |
| PKCE S256 | 已支持并已声明 |
| 向腾讯索取回调地址或 client_id | **不需要**。动态注册里客户端自带 redirect_uri，client_id 由我方签发 |
| 为回环回调放开端口匹配（RFC 8252 §7.3） | **不需要**。回调服务器用 `server.listen(0)` 拿随机端口，但客户端在 `connect()` 时若发现没有 refresh_token 会先作废已注册的 client 再重新注册——凡是真要跳浏览器的时候，它刚用当前端口注册过。精确匹配即可 |
| 改现有端点路径 | 不必 |
| 动 MCP server / 生产镜像 / K8s 清单 | 完全无关 |

## 五、代码位置

`AtlasCloudTeam/kubedl`，分支 **master**：

```
console/backend/pkg/authzserver/metadata.go    发现文档，registration_endpoint 缺在这里
console/backend/pkg/authzserver/registry.go    客户端注册表
console/backend/pkg/routers/api/oidc.go        端点挂载
```

> ⚠️ `feat/oidc-provider` 分支（`pkg/oidcprovider/`）是 2026-08-18 未合并的旧实现，
> 不是生产代码，别照它改。

`metadata.go` 现在有一句注释说明为何不声明注册端点：「客户端的选用优先级是
预注册 → 元数据文档 → 动态注册，声明了元数据文档就不会走到动态注册」。
这对 ChatGPT 和 Codex 成立，但 WorkBuddy 的 SDK 不实现元数据文档，落不到这条链上。

## 六、验收

```bash
# 1. 发现文档公布了注册端点
curl -s https://auth.atlascloud.ai/.well-known/oauth-authorization-server \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("registration_endpoint") or "❌ 仍未公布")'

# 2. 动态注册能过，且回显 redirect_uris、不发 client_secret
REG=$(curl -s https://auth.atlascloud.ai/.well-known/oauth-authorization-server \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["registration_endpoint"])')
curl -s -X POST "$REG" -H 'Content-Type: application/json' -d '{
  "client_name":"WorkBuddy","application_type":"native",
  "token_endpoint_auth_method":"none",
  "grant_types":["authorization_code","refresh_token"],
  "response_types":["code"],
  "redirect_uris":["http://127.0.0.1:51888/oauth/callback"]
}' | python3 -m json.tool

# 3. 拿注册回来的 client_id 走授权端点，不再是 invalid_client（把 <CLIENT_ID> 换掉）
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://auth.atlascloud.ai/authorize?client_id=<CLIENT_ID>&response_type=code\
&redirect_uri=http%3A%2F%2F127.0.0.1%3A51888%2Foauth%2Fcallback\
&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&scope=tasks%3Aread"
# 期望 302 跳登录页（现在是 401 invalid_client）
```

对照样板：`curl -s https://mcp.fenbeitong.com/.well-known/oauth-authorization-server`

## 七、我方已就绪

```
https://mcp.atlascloud.ai/.well-known/oauth-protected-resource
  resource               https://mcp.atlascloud.ai/mcp
  authorization_servers  ["https://auth.atlascloud.ai"]
  scopes_supported       ["tasks:read"]
```

MCP server 一行不用改。这个端点做完，WorkBuddy 就能走通整条链路，**不需要和腾讯做任何沟通**。

## 参考

- RFC 7591 动态客户端注册：https://www.rfc-editor.org/rfc/rfc7591
- WorkBuddy 连接器规范：https://open.workbuddy.cn/docs/connector
