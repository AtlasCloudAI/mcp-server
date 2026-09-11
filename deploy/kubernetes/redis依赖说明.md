# MCP Server 的 Redis 依赖

给运维：这个服务需要一个 Redis。下面是它用来干什么、规格要求、以及两种提供方式。

**一句话结论：极小。跑了 30 天实测占 1.51 MB、265 个键。单实例够用，
也可以用现成的共享 Redis。唯一不能将就的一条是淘汰策略必须 `noeviction`。**

---

## 用来干什么

**只有一件事：防重复扣费。**

每个生成调用（图 / 视频 / 音频）都包在一个幂等键里，三个状态：

| 状态 | 行为 |
|---|---|
| `pending` | 同一个 key 还在进行中 → 拒掉第二次，不重复提交 |
| `completed` | 已完成 → 直接返回上次结果，不再调一次生成 |
| `uncertain` | 上次请求没拿到确认响应 → 明确报错让用户去查账单，而不是默默再跑一次 |

没有它，一次网络抖动或客户端重试 = 扣两次钱。**Codex 本身会重试**，所以这不是
理论风险。

### 里面【没有】什么

- ❌ 没有用户的 API key
- ❌ 没有 OAuth 令牌。换来的令牌只存在进程内存的一个 Map 里
  （`src/services/token-exchange.ts`），不落 Redis、不落磁盘
- ❌ 没有确认令牌。$20 以上生成的报价确认走无状态 HMAC，也不存 Redis

**所以它不需要是专用实例**，里面没有任何需要隔离的敏感数据。

---

## 规格要求

| 项 | 要求 | 说明 |
|---|---|---|
| 版本 | 5.0+ | 线上跑的是 8.6.3。只用到 `SET NX` / `GET` / `DEL` / TTL，没有特殊命令 |
| 模式 | standalone 即可 | 不需要 cluster，不需要哨兵 |
| 内存 | 128 MB 够 | 实测 30 天 1.51 MB。给 256 MB 上限已经很宽裕 |
| 磁盘 | 1 GB | 开了 AOF。不开也能用，代价是重启丢去重窗口 |
| 密码 | **必须有** | 服务在生产档位会拒绝无密码的连接串，直接启动失败 |
| **淘汰策略** | **`noeviction`** | **见下，这是唯一不能将就的一条** |
| 副本 | 1 个够 | 数据可重建（丢了只是去重窗口空一段），不需要高可用 |

### ⚠️ 淘汰策略必须是 `noeviction`

如果用托管 Redis，请确认它**不是** `allkeys-lru` / `allkeys-random` 之类。

原因：被淘汰掉的幂等键 = 那次请求的"已经跑过"记录消失 = 重试时会**再扣一次钱**。
这类 bug 不会报错、不会有日志，只会在账单上体现，而且很难追溯到是哪一笔。

我们的键本来就都带 TTL（默认 86400 秒）会自己过期，所以不需要靠淘汰来控制内存。

---

## 两种提供方式

### 方式一：用清单自带的（推荐，不用你准备）

`deploy/kubernetes/base/staging.yaml` 里已经包含一套完整的单副本 Redis，
`kubectl apply -k` 时会一起建好：

- `Service/atlascloud-plugin-redis` — ClusterIP :6379
- `StatefulSet/atlascloud-plugin-redis` — 1 副本
- `NetworkPolicy/atlascloud-plugin-redis-ingress` — 只允许 MCP 的 pod 连它

你只需要在 Secret `atlascloud-openai-plugin` 里放两个键：

```
redis-password   = <随机密码>
redis-url        = redis://:<同一个密码>@atlascloud-plugin-redis:6379
```

两个值必须是同一个密码 —— StatefulSet 用 `redis-password` 启动 Redis，
MCP 用 `redis-url` 连它。

现有清单的关键配置：

| 配置 | 值 |
|---|---|
| 镜像 | `bitnami/redis`，按 digest 钉死（线上 8.6.3） |
| 持久化 | `REDIS_AOF_ENABLED=yes` |
| 密码 | `ALLOW_EMPTY_PASSWORD=no`，从 Secret 取 |
| 资源 | requests 50m CPU / 96Mi；limits 500m / 256Mi |
| 存储 | PVC 1Gi，`storageClassName: openebs-hostpath` ← **生产集群可能要换** |
| 安全 | 非 root（uid 1001）、`drop: ALL`、`seccompProfile: RuntimeDefault` |
| 探针 | `redis-cli ping` |

> **生产集群要改的只有一处**：`storageClassName: openebs-hostpath` 是现集群的
> storage class，生产如果不一样，把它换成生产的即可（或删掉这行用默认 class）。

### 方式二：你给一个现成的 / 托管的

把 `redis-url` 换成你的连接串就行，自带那套 StatefulSet 留着不影响
（也可以从清单里删掉）。

格式：

```
redis://:<密码>@<主机>:6379
redis://<用户名>:<密码>@<主机>:6379      # Redis 6+ 的 ACL 用户
rediss://:<密码>@<主机>:6379            # 走 TLS
```

**必须带密码**，否则服务在生产档位直接拒绝启动。

这种方式下 `redis-password` 这个键就不需要了（那是给自带 StatefulSet 用的）。

---

## 实测用量（线上 30 天）

```
redis_version:     8.6.3
redis_mode:        standalone
used_memory_human: 1.51M
键数量:            265
maxmemory:         0（不限制）
maxmemory_policy:  noeviction
PVC:               1Gi（已用极少）
```

按这个增速，1 GB 存储和 256 MB 内存都远远用不完。

---

## 谁能连它

自带清单的 NetworkPolicy 只放行带这些标签的 pod：

```yaml
podSelector:
  matchLabels:
    app.kubernetes.io/name: atlascloud-openai-plugin
    app.kubernetes.io/component: redis
ingress:
  - from:
      - podSelector:
          matchExpressions:
            - key: app.kubernetes.io/component
              operator: In
              values: ["mcp", "auth"]
    ports:
      - protocol: TCP
        port: 6379
```

`auth` 那一项是历史遗留（自建授权服务器已停用、生产不部署），留着不影响，
也可以只留 `mcp`。

---

## 挂了会怎样

| 情况 | 后果 |
|---|---|
| Redis 连不上（启动时） | **MCP Pod 启动失败**。生产档位强制 `MCP_IDEMPOTENCY_BACKEND=redis` |
| Redis 中途挂掉 | 生成请求报错，不会静默放过。修好即恢复 |
| Redis 数据丢了 | 只丢去重窗口。已完成的生成不受影响，坏处是那个窗口内的重试可能重复扣费 |
| 键被淘汰策略淘汰 | **最糟的情况**：不报错、无日志，重试时重复扣费。所以要 `noeviction` |
