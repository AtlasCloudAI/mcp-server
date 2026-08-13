import type { Request, RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { HttpServerConfig } from "../config.js";
import { isAtlasToolName, TOOL_POLICIES } from "../tool-policy.js";
import { isExactAllowedHost } from "./host-validation.js";

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
      if (!req.auth?.scopes.includes(requiredScope)) {
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
