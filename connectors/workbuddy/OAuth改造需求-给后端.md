# WorkBuddy 一键登录 · 给后端

> 这一份既是发给后端的说明，也是完整规格，不另存一份。
> 仓库位置：`mcp-server` 仓 `connectors/workbuddy/OAuth改造需求-给后端.md`

---

WorkBuddy（腾讯）连接器要接一键登录，需要官网 OIDC 加 **RFC 7591 动态客户端注册**。

## 工作量

两件，都在 `AtlasCloudTeam/kubedl` 的 **master** 分支：

1. **注册端点 + 发现文档加字段**。端点本身不复杂。
2. **注册出来的客户端要落库**，跨副本可见，且在 refresh_token 有效期内一直有效（刷新令牌时 token 端点要校验 client_id）。**这件才是主体，可能要建表。**

   **这张表会持续长，设计时要带回收。** WorkBuddy 不是注册一次就长期复用：
   它 `connect()` 时若发现本地没有 refresh_token，会先作废已注册的 client 再重新注册。
   也就是说每次「重新授权」都会新增一行，同一个用户同一个连接器会攒出多条。
   建议加 `last_used_at` 并对长期未用的做过期清理，否则是一张无界表。

协议能力那一层已经全齐，一个字不用动：PKCE S256、`authorization_code` + `refresh_token`、公开客户端（`token_endpoint_auth_methods_supported` 含 `none`）、资源指示符。

拿一家已在 WorkBuddy 上架的友商逐项对照，**公示的能力差距只有一行**：

| 字段 | 分贝通 | 我们 |
|---|---|---|
| code_challenge_methods_supported | S256 | S256 ✅ |
| grant_types_supported | code + refresh_token | 同 ✅ |
| token_endpoint_auth_methods_supported | 含 none | 含 none ✅ |
| **registration_endpoint** | **有** | **无** ❌ |

但别把这张表读成「只要加个字段」——公示差一行，背后要多一套客户端存储。

## 为什么必须做，不是我们一家的要求

WorkBuddy 桌面端内置官方 MCP TypeScript SDK 1.24.3，缺 `registration_endpoint` 时直接抛
`Incompatible auth server: does not support dynamic client registration`。

市场上 236 个连接器里，142 个是远程服务且不收用户凭证（也就是要么 OAuth、要么免鉴权）。
抽查其中五个第三方，授权服务器**都**提供动态注册端点：

- Canva `https://mcp.canva.cn/register`
- 千图网 `https://ai.58pic.com/oauth/register`
- 八爪鱼 `https://identity.bazhuayu.com/connect/register`
- FastMoss `https://mcp.fastmoss.com/oauth/register`
- 分贝通 `https://mcp.fenbeitong.com/register`

（是抽查五个，不是把 142 个都验了；也没验它们的 OAuth 端到端跑通，只验了端点公示。）

## 无代码的路我都试过了，都不成立

会先想到的三条，逐条排除：

**端点已存在只是没公示？** 不是。扫了 13 个可能路径 —— `/reg`、`/register`、`/oauth/register`、
`/oauth2/register`、`/connect/register`、`/oidc/register`、`/api/v1/oidc/register`、`/clients`、
`/oauth/clients`、`/v1/register`、`/dcr` 等，POST 全部 404。发现文档 17 个字段里带 `regist` 的一个都没有。

**用现成的 CIMD 通道？** 走不通，但原因值得说清楚，免得你们查 SDK 时得出相反结论。
**SDK 本身是支持 CIMD 的**（SEP-991，URL-based Client ID），条件是：

```js
supportsUrlBasedClientId = metadata?.client_id_metadata_document_supported === true
shouldUseUrlBasedClientId = supportsUrlBasedClientId && provider.clientMetadataUrl
```

我们的发现文档已经声明了前者。但 **WorkBuddy 没把 `clientMetadataUrl` 接上** ——
它 `createProvider()` 从函数头到 `return provider` 整段（约 9900 字符）里没有这个字段，
所以后半个条件恒假，永远落到动态注册。它还为 DCR 做了 leader/follower 协调，
说明那是设计主路径。

**从连接器配置注入？** 不行。`createProvider()` 整段里**一处都没有读 `serverConfig`**，
我们在 `mcp.json` 里加任何字段都进不去。

## 顺带一提，一条不受我们控制的省事路

如果 WorkBuddy 愿意在它的 provider 里传 `clientMetadataUrl`，我们只要把它的域名加进
`AUTH_CLIENT_ID_METADATA_HOSTS`（现在只有 `chatgpt.com`），**零代码**。
但这要等他们发桌面端新版，而且他们为 DCR 做了专门的协调逻辑，不太可能为一家改。
可以提，但不能当方案等。

## 排不进来的话，有退路

回到「用户自己粘 Atlas API Key」的模式，后端完全不动。代价是要把
`atlascloud-mcp` 的新版发到 npm（包 owner 目前只有 mikewangatlas），
而且丢掉「不用贴 key」这个产品主张。不推荐，但如果这季度排不进来，这条能上线。

## 一个已经验证过的前置，不用你们操心

我们的资源元数据只公示 `tasks:read`，但 7 个生成工具要 `tasks:write`、3 个账务工具要
`billing:read`。这是有意的 step-up 设计：客户端先拿只读令牌，撞到 403 `insufficient_scope`
时再申请写权限，让「同意消耗额度」发生在用户第一次真要生成的时刻。

我们自己代码注释里标着这条「没实测过」，所以我去验了 WorkBuddy 的 SDK，**它实现了**：

```js
if (response.status === 403 && this._authProvider) {
  const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);
  if (error === 'insufficient_scope') { /* upscoping，并有防无限循环的去重 */ }
}
```

我们服务端返回的正是 `Bearer error="insufficient_scope", scope="<所需>", resource_metadata="…"`，
字段对得上。**所以 DCR 做完之后不会再卡在 scope 上**，授权服务器的 scope 词表
（`openid`/`offline_access`/`tasks:read`/`tasks:write`/`billing:read`）也已经齐了，不用动。

## 端点细节

路径随意，WorkBuddy 从发现文档读 `registration_endpoint`，现有端点一个都不用改名。

请求（公开原生客户端）：

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

- 响应 `201` + JSON，**应原样回显 `redirect_uris`**。文档把这条写成硬要求；
  实测客户端有兜底会自己补（它代码里注释「部分服务端的 DCR 响应不回显 redirect_uris」），
  但既然文档要求就照做，别依赖对方兜底。
- **不要签发 `client_secret`**，公开客户端靠 PKCE。
- 注册是未鉴权入口，建议按 IP 限流（`ratelimit.go` 有现成设施）。
- 回调地址由客户端注册时自带，**不需要向腾讯索取，也不需要我们事先知道**。

## 代码位置

```
console/backend/pkg/authzserver/metadata.go    发现文档，registration_endpoint 缺在这里
console/backend/pkg/authzserver/registry.go    客户端注册表，现有两个来源
console/backend/pkg/routers/api/oidc.go        根路径端点挂载（RegisterRootRoutes）
```

⚠️ 仓库里 `feat/oidc-provider` 分支（`pkg/oidcprovider/`，2026-08-18）是未合并的旧实现，
路径是 `/api/v1/oidc/authorize`，而生产是 `/authorize`。别照它改。

`metadata.go` 里有一句注释说明当初为何不公示注册端点：「客户端的选用优先级是
预注册 → 元数据文档 → 动态注册，声明了元数据文档就不会走到动态注册」。
这对 ChatGPT 和 Codex 成立，WorkBuddy 是那条链覆盖不到的情况。

## 两件不用做的

**不用改回环回调的端口匹配。** WorkBuddy 的回调服务器每次用随机端口（`server.listen(0)`），
看着像要按 RFC 8252 §7.3 忽略端口。但它 `connect()` 时若发现没有 refresh_token，
会先作废已注册的 client 再重新注册 —— 凡是真要跳浏览器的时候，它刚用当前端口注册过。
精确匹配就够。

**大概不用动网关。** 我一度以为 `auth.atlascloud.ai` 外面有路径白名单，
判据是 `/healthz`、`/me` 返回 404。那个判据是错的 —— 那两个路由属于另一个不部署的实现，
kubedl 里根本没有。用 kubedl 真实存在的根路由复测：`/authorize`、`/token`、`/jwks`、
`/consent`、`/.well-known/*` 全部到达应用（401 或 200，不是 404）。
所以新加的根路由应该也能到。**保险起见改完从外网 curl 一次确认**，但不必预先申请放行。

## 验收

```bash
# 1. 发现文档公示了注册端点
curl -s https://auth.atlascloud.ai/.well-known/oauth-authorization-server \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("registration_endpoint") or "❌ 仍未公示")'

# 2. 注册能过，回显 redirect_uris，且不发 client_secret
REG=$(curl -s https://auth.atlascloud.ai/.well-known/oauth-authorization-server \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["registration_endpoint"])')
curl -s -X POST "$REG" -H 'Content-Type: application/json' -d '{
  "client_name":"WorkBuddy","application_type":"native",
  "token_endpoint_auth_method":"none",
  "grant_types":["authorization_code","refresh_token"],
  "response_types":["code"],
  "redirect_uris":["http://127.0.0.1:51888/oauth/callback"]
}' | python3 -m json.tool

# 3. 拿上一步的 client_id 走授权端点，不再是 invalid_client
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://auth.atlascloud.ai/authorize?client_id=<CLIENT_ID>&response_type=code\
&redirect_uri=http%3A%2F%2F127.0.0.1%3A51888%2Foauth%2Fcallback\
&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&scope=tasks%3Aread"
# 期望 302 跳登录页（现在是 401 invalid_client）

# 对照样板
curl -s https://mcp.fenbeitong.com/.well-known/oauth-authorization-server
```

三条全过之后叫我，我在 WorkBuddy 里装连接器实测一次完整授权，把结果回给你们。

## 我方已就绪

```
https://mcp.atlascloud.ai/.well-known/oauth-protected-resource
  resource               https://mcp.atlascloud.ai/mcp
  authorization_servers  ["https://auth.atlascloud.ai"]
  scopes_supported       ["tasks:read"]
```

MCP server、生产镜像、K8s 清单一行不用改。
