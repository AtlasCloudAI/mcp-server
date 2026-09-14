# 生产清单（运维编写）

这套是运维实际要 apply 的清单，纯 YAML、按序号执行，不用 kustomize。

```bash
kubectl apply -f 00-namespace.yaml
kubectl apply -f registry-secret.yaml     # 本地那份真值，不在仓库里
kubectl apply -f 01-configmap.yaml
kubectl apply -f 02-secrets.yaml          # 同上
kubectl apply -f 03-service.yaml
kubectl apply -f 04-deployment.yaml
kubectl -n atlas-mcp rollout status deployment/atlas-mcp
```

## ⚠️ 两个 Secret 不在仓库里

这个仓库是**公开**的。`02-secrets.yaml` 和 `registry-secret.yaml` 被
`.gitignore` 挡住，只提交了 `*.example.yaml` 模板。

填好真值的那两份留在本地或密钥管理系统里。镜像拉取凭据也可以完全不落文件：

```bash
kubectl -n atlas-mcp create secret docker-registry atlas-registry-secret \
  --docker-server=registry.atlascloud.ai \
  --docker-username='<用户名>' --docker-password='<密码>'
```

## 上线前必须先定的三件事

### 1. 域名到底用哪个 —— 现在两个都不通

清单里写的是 `atlascloud-mcp.atlascloud.ai`（按 dev 的
`atlascloud-mcp.dev.atlascloud.ai` 1:1 复刻）。但实测：

| 域名 | DNS | HTTP |
|---|---|---|
| `atlascloud-mcp.atlascloud.ai` | **没有记录** | 连不上 |
| `mcp.atlascloud.ai` | 有 | 525，回源未配 |

先前加进 Cloudflare 的是 `mcp.atlascloud.ai`，和清单里写的不是同一个。
**二选一，然后：**

- 选 `atlascloud-mcp.atlascloud.ai` → 要先加 DNS 记录
- 选 `mcp.atlascloud.ai` → 要改 `01-configmap.yaml` 三处
  （`MCP_PUBLIC_URL` / `MCP_ALLOWED_HOSTS` / `MCP_OAUTH_AUDIENCE`）
  和 `04-deployment.yaml` 两处探针 Host

**不管选哪个，授权服务器里登记的资源标识必须和 `MCP_OAUTH_AUDIENCE` 逐字符一致。**
差一个字符的表现是每个请求都 401，而且不会有配置错误的提示。

### 2. 托管 Redis 的淘汰策略必须是 `noeviction`

连的是阿里云托管实例的 db 250。**共享实例的 `maxmemory-policy` 是实例级的**，
如果它是 `allkeys-lru` / `volatile-lru` 之类，被淘汰掉的幂等键就等于
「这次生成已经跑过」的记录消失，客户端重试时会**重复扣费** ——
不报错、无日志，只在账单上体现。

我们的键都带 TTL 会自己过期，不需要靠淘汰控内存。请确认：

```bash
redis-cli -h <主机> -a <密码> CONFIG GET maxmemory-policy
```

### 3. `atlas-mcp-server` 这个客户端在生产授权服务器里登记了吗

`01-configmap.yaml` 里 `MCP_TOKEN_EXCHANGE_CLIENT_ID: atlas-mcp-server`。
需要 AS 管理员确认它确实存在、开了 `urn:ietf:params:oauth:grant-type:token-exchange`
这个 grant，并且 `02-secrets.yaml` 里那个 `client-secret` 是它的明文 secret。

## 建议改的三处（不改也能跑）

| 位置 | 现在 | 建议 | 为什么 |
|---|---|---|---|
| `01-configmap.yaml` | `PLUGIN_RELEASE_TIER: staging` | `production` | 这份配置逐条对过生产门禁，四条全过，改了照样能启动。留 `staging` 等于自愿放弃那几道校验 |
| `01-configmap.yaml` | 有 `MCP_CREDENTIAL_REDIS_PREFIX` | 删掉 | 只有 `redis-subject-map` 模式用它给 Redis 里的凭据加前缀。`oauth-exchange` 不存凭据，这项没有作用 |
| `04-deployment.yaml` + `02-secrets.yaml` | 注入 `MCP_CREDENTIAL_ENCRYPTION_KEYS_JSON` | 删掉 | 同上，旧架构遗留。代码里 `createConfiguredCredentialResolver` 在建 store 之前就 return 了，这个钥匙串**永远不会被读到**。现在填的还是一串全 A 的假值 |

## 还缺一个 Ingress

这六个文件里没有 Ingress，所以现在没有任何东西把外部流量路由到
`Service/atlas-mcp`。要么补一条，要么说明用的是别的路由方式
（比如从 Higress 控制台建）。

无论哪种，这个 host 需要：

- 超时 **120 秒**（MCP 是流式长连接，默认 60 秒会把生成中的请求掐断）
- body 上限 **256k**
- 不被 Cloudflare Access 拦（生产的 `api.atlascloud.ai` 和
  `auth.atlascloud.ai` 本来就不在 Access 后面，配成一样即可）

## 和 `../production.example/` 的关系

`../production.example/` 是同一件事的 kustomize 版本，比这套早写。两者的差别：

| | 这套（运维） | `production.example/`（kustomize） |
|---|---|---|
| 命名空间 | `atlas-mcp`（新建） | `mcp-servers`（沿用现有） |
| 资源名 | `atlas-mcp` | `atlascloud-openai-mcp` |
| 域名 | `atlascloud-mcp.atlascloud.ai` | `mcp.atlascloud.ai` |
| Redis | 阿里云托管 | 清单自带单副本 StatefulSet |
| 配置注入 | ConfigMap + `envFrom` | Deployment 里逐条 env |
| Ingress | 无 | 有 |

**以这套为准** —— 它是运维实际会 apply 的。`production.example/` 保留作参考，
里面的注释解释了每个变量为什么是那个值。

全部变量的取值、来源和理由见 [`../production.env.example`](../production.env.example)。
