# WorkBuddy 连接器

面向腾讯 WorkBuddy 开放平台的连接器包。规范见
<https://open.workbuddy.cn/docs/connector>，提交入口 <https://open.workbuddy.cn/connector/publish>。

## 当前方案：stdio + 用户自填 API Key

```
connectors/workbuddy/
├── connector-meta.json   必须
├── mcp.json              必须 —— npx 拉起本地 stdio server
├── token-schema.json     auth_mode=token 时必须，描述凭证表单
├── icon.svg              必须
└── skills/               三个 skill，指导 AI 正确调用
```

用户在 WorkBuddy 里点「连接」→ 弹表单填自己的 Atlas API Key → 凭证只存本机
`~/.workbuddy`，不过云端 → WorkBuddy 托管一个 Node 20 运行时，用 npx 拉起
`atlascloud-mcp`，把 key 作为环境变量注入。

stdio 模式暴露 **14 个工具**，比远程多 `atlas_chat` 和 `atlas_upload_media`。

### 上线路径：先测后放，别一步到生产

`mcp.json` 钉的是 `atlascloud-mcp@2.5.0`，**这个版本还没发到 npm**。
npm 上最新是 `1.7.0`（2026-08-27 发布，是 main 分支那套旧服务，不是本分支），
近 30 天有 3078 次下载。直接把 `latest` 翻到 2.5.0，等于给这些人换了个服务。

平台侧没有沙箱可用。连接器状态只有草稿 / 审核中 / 待发布 / 已发布 / 已驳回 /
强制下架 / 已下架，没有测试态，所以绕不开 npm。按下面三步走。

#### 第 1 步　挂进本机客户端，不碰 npm 也不碰平台

WorkBuddy 客户端把所有连接器的 MCP 配置汇总在 `~/.workbuddy/connectors/default/mcp.json`，
键名是 `connector:<source>`。往里加一条指向本机构建产物的 stdio 配置就能直接测：

```bash
npm run build                                   # 在仓库根目录
./connectors/workbuddy/本地挂载.sh <你的 API Key>
# 完全退出 WorkBuddy（cmd+Q）再重开
./connectors/workbuddy/本地挂载.sh --revert     # 测完还原
```

脚本会先备份再改，`--revert` 逐字节还原。API Key 会明文落在那个文件里，测完记得还原。

客户端里也有「自定义连接器」面板（`连接器管理 → 自定义连接器`），效果一样，
走 UI 更直观。企业管理员可以禁用这个入口，你是超管所以能放开。

**这一步只能测 MCP 工具，测不了 Skill。** 本地 `~/.workbuddy/skills/` 是空的，
市场里 228 个连接器的元信息一个都没落本地（`connector-meta.json` 本地 0 个），
说明名称、描述、Skill 的装载都由服务端下发。Skill 要验，只能走平台包那条路。

#### 第 2 步　发预发布版，验真实安装路径

```bash
npm version 2.5.0-beta.1 --no-git-tag-version
npm run build && npm test
npm publish --tag next          # ← --tag next 不能省
```

**`--tag next` 必须带。** 不带的话 npm 会把它设成 `latest`，那 3078 次下载就全
拉到预发布版了。带了之后 `latest` 仍然是 1.7.0，只有显式写版本号的人才拿得到。

然后把 `mcp.json` 里的版本改成 `atlascloud-mcp@2.5.0-beta.1`，重新打包上传草稿，
走一遍真实安装路径：WorkBuddy 托管 Node 20 → npx 从 npm 拉包 → 注入 key → 起进程。

#### 第 3 步　转正并提审

测通之后把版本改回 `2.5.0`，`npm publish`（这次不带 `--tag`，正式接管 `latest`），
`mcp.json` 钉回 `atlascloud-mcp@2.5.0`，重新打包提交审核。

#### 顺带验到的两件事

官方连接器就是这么写的，我们的格式没跑偏。`ai-hive` 的 `mcp.json` 是
`npx -y <包名>@latest` 加 `runtime: {type: "node"}`，和我们第 2 步要提交的形状一致；
228 个连接器里 49 个用 `token-schema.json`，自填凭证是条成熟路子不是偏门。

#### 发包前已经堵掉的坑

`package.json` 原本没有 `files` 字段，`npm pack` 会把 `deploy/kubernetes/` 的生产
清单、`test/`、`scripts/`、`.github/workflows/` 一起推到公共 npm 上，302 个文件。
现已加上 `files: ["dist","README.md"]`，降到 158 个。打出的 tarball 已实测装上能跑，
14 个工具。

## 为什么没用 OAuth（和 Codex 体验一致的那套）

WorkBuddy 内置的 OAuth 管理器要求 **RFC 7591 动态客户端注册**。我们的授权服务
走的是 CIMD，两者对不上。实测：

| 检查项 | 结果 |
|---|---|
| `auth.atlascloud.ai/.well-known/oauth-authorization-server` 里的 `registration_endpoint` | 没有 |
| `POST /oauth/register`、`POST /register` | 都是 404 |
| 元数据里声明的能力 | `client_id_metadata_document_supported`（CIMD） |
| CIMD 主机白名单 `AUTH_CLIENT_ID_METADATA_HOSTS` | 默认只有 `chatgpt.com` |

回调地址也过不了。`src/auth/client-registration.ts` 的白名单只认两种形状：

- `https://chatgpt.com/connector/oauth/{id}`
- `http://127.0.0.1:{port}/callback/{12位随机串}`

WorkBuddy 要的两种都不匹配：私有协议 `workbuddy://workbuddy/mcp/connector%3A<source>/oauth/callback`
协议就不对；回退的 `http://127.0.0.1:{port}/oauth/callback` 路径也对不上那条正则。

要打通，授权服务需要改三处：

1. 挂出动态注册端点，并在 AS 元数据里公布 `registration_endpoint`。
   校验逻辑 `validateDynamicClientRegistration()` 已经写好了，但目前没有任何调用方，是死代码。
2. 把 WorkBuddy 的两种回调加进 `isSupportedCallback()`。这个函数同样已写好且无人调用。
3. 让 `/authorize` 接受动态注册产生的 client_id，现在只认 CIMD 的 https URL 形式。

改完之后，用 `mcp.oauth.json.待启用` 替换 `mcp.json` 即可。

另一条不用改代码的路子：WorkBuddy 文档提到 `auth_mode` 还有 `server-side` 和 `gateway`
两种由它云端托管 OAuth 的模式，但要「接入前与 WorkBuddy 团队确认」，属于商务沟通。

## 远程地址 + 自填 Token 为什么也不行

试过了。拿 Atlas API Key 当 bearer 打 `https://mcp.atlascloud.ai/mcp` 返回
`401 invalid_token`，远程服务只认授权服务签发的 JWT。要走通得在服务端加一条
「Atlas key 直通」的凭证模式。

## 打包提交

```bash
cd connectors/workbuddy && zip -r ../../atlas-cloud-workbuddy.zip . -x '.*'
```

限制 20MB，本包约 600KB。上传后平台自动解包并生成连接器 ID，再提交审核，
审核通过进连接器市场，后续更新重新提交，通常 10~15 分钟同步生效。
