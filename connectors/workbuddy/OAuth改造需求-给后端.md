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

## 三、代码在哪

授权服务器在 **`AtlasCloudTeam/kubedl`**，分支 `master`：

```
console/backend/pkg/authzserver/          授权服务器本体
  metadata.go        发现文档字段（registration_endpoint 就缺在这里）
  registry.go        客户端注册表：配置登记 + 元数据文档两个来源
  flow.go / storage.go / strategy.go
console/backend/pkg/routers/api/oidc.go   HTTP 端点挂载
```

> ⚠️ 仓库里还有一条 `feat/oidc-provider` 分支（2026-08-18，`console/backend/pkg/oidcprovider/`），
> **那是未合并的旧实现，不是生产代码**，别照它改。

### 现在不声明注册端点是有意为之

`metadata.go` 里写着：

> 刻意不声明 `registration_endpoint`：客户端的选用优先级是
> 预注册 → 元数据文档 → 动态注册，声明了元数据文档就不会走到动态注册。

这个判断对**遵循 MCP 规范的客户端**成立，ChatGPT 和 Codex 就是这么走的。
但 **WorkBuddy 不实现元数据文档（CIMD），它只做动态注册**，所以落不到这条优先级链上，
直接卡死在第一步。这是要改的原因，不是原设计错了。

## 四、要做的四件事

### 1. 公布并实现 `registration_endpoint`

- `metadata.go` 的 `Metadata` 结构加字段并在 `Metadata()` 里填值
- `oidc.go` 挂一个 `POST` 路由
- **端点路径随意**，WorkBuddy 从发现文档里读，现有端点一个都不用改名

WorkBuddy 会发的请求（公开原生客户端）：

```json
{
  "client_name": "WorkBuddy",
  "application_type": "native",
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "redirect_uris": ["http://127.0.0.1:{随机端口}/oauth/callback"]
}
```

响应硬要求：`201` + JSON，**除 `client_id` 外必须原样回显 `redirect_uris`**，
否则 WorkBuddy 流程直接中断。**不要签发 `client_secret`**。

注册是未鉴权入口，建议按 IP 限流（`ratelimit.go` 已有现成设施）。

### 2. `clientRegistry` 加第三个来源

现在 `registry.go` 的注释写明客户端有两个来源：配置登记的第一方客户端启动时全量加载，
元数据文档 URL 标识的第三方客户端按需抓取。动态注册产生的客户端是第三种，
需要落库并在多副本间共享，`Lookup` 走 DB 那一路。

### 3. 回环回调按 RFC 8252 §7.3 匹配

WorkBuddy 每次用随机端口，注册和授权用的是同一个具体地址，
但如果复用客户端就会出现端口不一致。RFC 8252 §7.3 明确要求：
**回环重定向地址在匹配时必须忽略端口**。

这不是放宽安全策略，是原生应用场景下规范要求的做法。
其余部分（scheme + host + path）仍然精确匹配，开放重定向的担心不成立。

### 4. 边缘网关放行注册路径

`auth.atlascloud.ai` 外面有一层路径白名单，把注册端点的路径加进去。
判据：`/healthz`、`/me` 是应用里真实存在的路由，在生产同样 404。

## 五、明确不用做的

| 项 | 为什么不用做 |
|---|---|
| 支持公开客户端 | **已支持**。`registry.go` 有 `Public` 标志，只有非公开客户端才要求 `SecretHash` |
| PKCE S256 | 已支持并已在发现文档里声明 |
| 支持 `workbuddy://` 私有协议回调 | **不必**。WorkBuddy 私有协议被拒后会自动回退一次到回环地址，只多一次失败往返 |
| 改现有端点路径 | 不必，WorkBuddy 从发现文档读 |
| 动 MCP server / 生产镜像 / K8s 清单 | 完全无关 |

## 六、验收命令（改完照着跑，三条全过即可）

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
  "redirect_uris":["http://127.0.0.1:51888/oauth/callback"]
}' | python3 -m json.tool
# 期望：有 client_id，且 redirect_uris 原样回显；没有 client_secret

# 3. 拿注册回来的 client_id 走授权端点，不再是 invalid_client
#    把 <CLIENT_ID> 换成上一步的值
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://auth.atlascloud.ai/authorize?client_id=<CLIENT_ID>&response_type=code\
&redirect_uri=http%3A%2F%2F127.0.0.1%3A51888%2Foauth%2Fcallback\
&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&scope=tasks%3Aread"
# 期望：302 跳登录页（现在是 401 invalid_client）
```

## 七、我方已就绪的部分

MCP server 侧不用任何改动，发现链路已经通：

```
https://mcp.atlascloud.ai/.well-known/oauth-protected-resource
  resource               https://mcp.atlascloud.ai/mcp
  authorization_servers  ["https://auth.atlascloud.ai"]
  scopes_supported       ["tasks:read"]
```

拿到用户令牌后，MCP server 用 RFC 8693 令牌交换换成面向 API 的令牌，
这条链路生产已跑通（Codex 就在用），与本次改造无关。

## 八、不做的替代路线

WorkBuddy 也支持 `auth_mode: server-side` / `gateway`，由它云端托管 OAuth，
我方不用改 OIDC，但要和腾讯 WorkBuddy 团队谈接入 —— 商务路径不是技术路径。

再退一步是现方案：用户自填 Atlas API Key（`auth_mode: token`），能上线，
但与「不用贴 key」的产品主张不一致。

另需注意：按 WorkBuddy 规矩，同一服务若同时提供 OAuth 与 Token 两种方式，
**必须用两个不同的 `source` 分别提交**，算两个独立连接器。

## 参考

- WorkBuddy 连接器规范：https://open.workbuddy.cn/docs/connector （见「MCP OAuth 流程」一节）
- RFC 7591 动态客户端注册：https://www.rfc-editor.org/rfc/rfc7591
- RFC 8252 §7.3 原生应用回环回调（端口必须忽略）：https://www.rfc-editor.org/rfc/rfc8252#section-7.3
