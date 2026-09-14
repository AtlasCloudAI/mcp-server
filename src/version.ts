import { readFileSync } from "node:fs";

/**
 * 服务器版本号，唯一事实源是 package.json。
 *
 * 这里曾经是一个写死的字符串，靠契约测试断言它和 package.json 一致。
 * 那道断言确实拦住过一次不同步（发版时只改了 package.json），但代价是
 * 一次失败的构建 —— 而这个值本来就不该有第二个来源。
 *
 * 镜像里 package.json 和 dist/ 是同级的（见 Dockerfile），本地跑 dist/ 或
 * 直接跑 src/ 时相对位置也一样，所以这个路径在两种形态下都成立。
 */
function readVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.trim() !== "") {
      return manifest.version;
    }
  } catch {
    // 读不到就落到下面的兜底：版本号只用于 serverInfo 的自我介绍，
    // 不值得为它让整个进程起不来。
  }
  return "0.0.0-unknown";
}

export const SERVER_VERSION = readVersion();
