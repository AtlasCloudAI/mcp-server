/**
 * 授权服务器自检的就绪门槛。
 *
 * 原来这道自检是启动的第一步，失败就 `process.exit(1)`。后果是授权服务器一抖动，
 * 我们就进 CrashLoopBackOff：k8s 的重启退避最长到 5 分钟，所以授权服务器恢复之后
 * 还要再等一个退避周期才回来，期间 pod 反复重启、日志断成一截一截，而且滚动更新
 * 会一直卡在「新 pod 起不来」上。
 *
 * 改成就绪门槛之后：进程照常监听，自检没过时 /readyz 返回 503、MCP 端点直接拒绝
 * （fail-closed 的语义一点没松），后台按退避持续重试，一通过就自动转为就绪。
 * k8s 那侧的效果不变——未就绪的 pod 不进 Service、滚动更新保留旧 pod——但恢复是
 * 秒级且无人工干预。
 */
import type { HttpServerConfig } from "../config.js";
import { fetchAndValidateAuthorizationServerMetadataWithRetry } from "./auth.js";

export interface AuthorizationServerReadiness {
  ready(): boolean;
  lastError(): string | undefined;
  /** 等到就绪为止，仅供测试与启动日志使用。 */
  whenReady(): Promise<void>;
  stop(): void;
}

export interface ReadinessProbeOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  fetcher?: typeof fetch;
  onAttemptFailed?: (error: unknown, attempt: number, nextDelayMs: number) => void;
  onReady?: (attempt: number) => void;
}

export function startAuthorizationServerProbe(
  config: HttpServerConfig,
  options: ReadinessProbeOptions = {}
): AuthorizationServerReadiness {
  const initialDelayMs = options.initialDelayMs ?? 2_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const fetcher = options.fetcher ?? fetch;

  let isReady = false;
  let lastErrorMessage: string | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveReady: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  let attempt = 0;
  const probe = async (): Promise<void> => {
    if (stopped) return;
    attempt += 1;
    try {
      // 单次尝试：重试节奏由这里的循环掌握，不要嵌两层退避。
      await fetchAndValidateAuthorizationServerMetadataWithRetry(config, fetcher, {
        attempts: 1,
      });
      isReady = true;
      lastErrorMessage = undefined;
      options.onReady?.(attempt);
      resolveReady?.();
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : "unknown error";
      if (stopped) return;
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.min(attempt - 1, 10));
      options.onAttemptFailed?.(error, attempt, delayMs);
      timer = setTimeout(() => void probe(), delayMs);
      timer.unref?.();
    }
  };

  void probe();

  return {
    ready: () => isReady,
    lastError: () => lastErrorMessage,
    whenReady: () => readyPromise,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** 自检已经通过的固定实现，给测试和 stdio 模式用。 */
export const alwaysReady: AuthorizationServerReadiness = {
  ready: () => true,
  lastError: () => undefined,
  whenReady: () => Promise.resolve(),
  stop: () => {},
};
