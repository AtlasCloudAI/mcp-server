import { ADVERTISED_SCOPES } from "../config.js";
import type { Request, RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { HttpServerConfig } from "../config.js";
import { isAtlasToolName, TOOL_POLICIES } from "../tool-policy.js";
import { isExactAllowedHost } from "./host-validation.js";

/**
 * MCP 客户端靠「未认证请求 → 401 + WWW-Authenticate」这一步找到 protected resource
 * metadata。Codex 发现连接器时先打的是 GET /mcp，而这个端点是无状态的、只接受 POST，
 * 直接回 405 就把发现链断在这里：客户端只能去猜 .well-known 路径——Codex 会猜（实测猜的是
 * /.well-known/oauth-protected-resource/mcp，能猜中），但那多两轮往返，而且不是每个客户端
 * 都会猜。所以没带任何凭据时先给挑战，带了凭据再按方法不支持处理。
 */
export function challengeUnauthenticated(resourceMetadataUrl: string): RequestHandler {
  return (req, res, next) => {
    if (req.headers.authorization) {
      next();
      return;
    }
    // 契约 v3 §6：401 必须带 resource_metadata 与 scope。缺少凭据时不带 error 参数
    // ——RFC 6750 把 error 留给「带了凭据但不被接受」的情形，这也是 aiproxy 的实测形状。
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl}", scope="${ADVERTISED_SCOPES.join(" ")}"`
    );
    res.status(401).json({ error: "invalid_token" });
  };
}

/**
 * 保证每一个 WWW-Authenticate 挑战都带 scope 参数（契约 v3 §6）。
 *
 * 401 挑战有三个来源：本文件的 challengeUnauthenticated、MCP SDK 的
 * requireBearerAuth、以及 http.ts 里凭据未绑定的分支。SDK 那个的头是它自己拼的，
 * 改不到；与其在三处各写一遍、日后再各漏一次，不如在链路上游统一补齐。
 * 已经带 scope 的头原样放行。
 */
export function ensureChallengeScope(): RequestHandler {
  return (req, res, next) => {
    // 请求是否真的带了凭据，决定挑战里该不该出现 error 参数。必须在处理链之前读，
    // 后面的中间件可能已经改写过 req。
    const hadCredentials = Boolean(req.headers.authorization);
    const original = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: unknown) => {
      if (
        String(name).toLowerCase() !== "www-authenticate" ||
        typeof value !== "string" ||
        !value.startsWith("Bearer")
      ) {
        return original(name, value as never);
      }
      let challenge = value;
      if (!hadCredentials) {
        // RFC 6750 把 error 留给「带了凭据但不被接受」。SDK 的 requireBearerAuth
        // 对缺失的头也报 invalid_token，这里改正——aiproxy 的实测响应同样不带 error。
        challenge = challenge
          .replace(/error(?:_description)?="(?:[^"\\]|\\.)*"\s*,?\s*/g, "")
          .replace(/^Bearer\s*,?\s*/, "Bearer ")
          .replace(/,\s*$/, "")
          .trim();
      }
      if (!/[,\s]scope=/.test(challenge)) {
        challenge = `${challenge}, scope="${ADVERTISED_SCOPES.join(" ")}"`;
      }
      return original(name, challenge);
    }) as typeof res.setHeader;
    next();
  };
}

export function enforceExactHost(config: HttpServerConfig): RequestHandler {
  return (req, res, next) => {
    if (!isExactAllowedHost(req.headers.host, config.allowedHosts, config.nodeEnv)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host header" },
        id: null,
      });
      return;
    }
    next();
  };
}

export function securityHeaders(config: HttpServerConfig): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Cache-Control", "no-store");
    if (config.nodeEnv === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

export function restrictedCors(config: HttpServerConfig): RequestHandler {
  return (req, res, next) => {
    const origin = req.header("Origin");
    if (!origin) {
      next();
      return;
    }
    if (!config.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "origin_not_allowed" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "MCP-Session-Id, WWW-Authenticate, RateLimit, RateLimit-Policy"
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function createPreAuthRateLimiter(
  config: HttpServerConfig
): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: config.preAuthRequestsPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate_limit_exceeded" },
  });
}

export function createSubjectRateLimiter(
  config: HttpServerConfig
): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: config.subjectRequestsPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => {
      const subject = req.auth?.extra?.sub;
      return typeof subject === "string" && subject !== ""
        ? `sub:${subject}`
        : `client:${req.auth?.clientId ?? "unknown"}`;
    },
    message: { error: "rate_limit_exceeded" },
  });
}

function calledToolNames(req: Request): string[] {
  const payloads = Array.isArray(req.body) ? req.body : [req.body];
  const names: string[] = [];
  for (const payload of payloads) {
    if (
      payload &&
      typeof payload === "object" &&
      payload.method === "tools/call" &&
      payload.params &&
      typeof payload.params === "object" &&
      typeof payload.params.name === "string"
    ) {
      names.push(payload.params.name);
    }
  }
  return names;
}

export function enforceToolScopes(
  config: HttpServerConfig,
  resourceMetadataUrl: string
): RequestHandler {
  return (req, res, next) => {
    for (const name of calledToolNames(req)) {
      if (!isAtlasToolName(name) || !TOOL_POLICIES[name].remote) {
        res.status(404).json({ error: "tool_not_available" });
        return;
      }
      const requiredScope = TOOL_POLICIES[name].scope;
      // null = 契约 v3 §4.2 的匿名可读目录：端点级认证已经足够，不再要求 scope。
      if (requiredScope !== null && !req.auth?.scopes.includes(requiredScope)) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${resourceMetadataUrl}"`
        );
        res.status(403).json({
          error: "insufficient_scope",
          error_description: `Tool ${name} requires scope ${requiredScope}`,
        });
        return;
      }
    }
    next();
  };
}
