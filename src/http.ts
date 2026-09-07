#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import type { Server as NodeHttpServer } from "node:http";
import type { Express, Request, RequestHandler, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  loadHttpServerConfig,
  type HttpServerConfig, ADVERTISED_SCOPES, resolveAdvertisedScopes } from "./config.js";
import {
  createConfiguredCredentialResolver,
  CredentialResolutionError,
  type AtlasCredentialResolver, type ResolvedCredential } from "./services/credential-resolver.js";
import {
  createRedisIdempotencyStore,
  InMemoryIdempotencyStore,
  type IdempotencyStore,
} from "./services/idempotency.js";
import { runWithRequestContext } from "./services/request-context.js";
import { createAtlasCloudServer } from "./server.js";
import {
  fetchAndValidateAuthorizationServerMetadataWithRetry,
  JwtAccessTokenVerifier,
} from "./http/auth.js";
import { OpenAIToolMetadataTransport } from "./http/openai-tool-metadata-transport.js";
import {
  challengeUnauthenticated,
  createPreAuthRateLimiter,
  createSubjectRateLimiter,
  enforceExactHost,
  enforceToolScopes,
  restrictedCors,
  securityHeaders,
  ensureChallengeScope,
} from "./http/middleware.js";
import {
  alwaysReady,
  startAuthorizationServerProbe,
  type AuthorizationServerReadiness,
} from "./http/readiness.js";

export interface HttpAppDependencies {
  verifier: OAuthTokenVerifier;
  idempotencyStore: IdempotencyStore;
  credentialResolver: AtlasCredentialResolver;
  /**
   * 授权服务器自检的就绪状态。省略即视为已就绪（stdio 模式与测试用）。
   * 未就绪时 MCP 端点拒绝一切请求——JWKS 拿不到就无法验签，放行等于不验令牌。
   */
  readiness?: AuthorizationServerReadiness;
}

/**
 * 授权服务器自检没过时拒绝一切 MCP 请求。
 *
 * 这不是保守，是必需：JWKS 拉不到就没法验签，而验签失败一律拒绝（fail-closed）。
 * 与其让每个请求各自撞一次 JWKS 超时、返回一堆 401，不如在入口一次说清「服务
 * 未就绪」，客户端也能据此重试而不是把令牌当成坏的。
 */
function requireAuthorizationServerReady(dependencies: HttpAppDependencies): RequestHandler {
  return (_req, res, next) => {
    if (dependencies.readiness?.ready() ?? true) {
      next();
      return;
    }
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "authorization server metadata is not yet validated; retry shortly",
      },
      id: null,
    });
  };
}

function protectedResourceMetadata(config: HttpServerConfig): Record<string, unknown> {
  return {
    resource: config.resourceId,
    authorization_servers: [
      config.authorizationServer.toString().replace(/\/$/, ""),
    ],
    // v3 §4.3：只公示 tasks:read，写权限走 step-up。
    // v3 §8：不含 offline_access —— refresh token 是客户端与 AS 之间的事。
    scopes_supported: resolveAdvertisedScopes(),
    bearer_methods_supported: ["header"],
    resource_name: "Atlas Cloud MCP Server",
    ...(config.resourceDocumentation
      ? { resource_documentation: config.resourceDocumentation.toString() }
      : {}),
  };
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed for stateless MCP" },
    id: null,
  });
}

export function createHttpApp(
  config: HttpServerConfig,
  dependencies: HttpAppDependencies
): Express {
  const resourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource",
    config.publicMcpUrl
  ).toString();
  const app = createMcpExpressApp({
    host: config.listenHost,
    allowedHosts: config.allowedHosts,
  });
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(enforceExactHost(config));
  app.use(securityHeaders(config));
  app.use(restrictedCors(config));

  const metadata = protectedResourceMetadata(config);
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(metadata);
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json(metadata);
  });
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    if (!config.challengeToken) {
      res.status(404).type("text/plain").send("not configured");
      return;
    }
    res.status(200).type("text/plain").send(config.challengeToken);
  });
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", service: "atlascloud-ai-media" });
  });
  app.get("/readyz", async (_req, res) => {
    const authorizationServerReady = dependencies.readiness?.ready() ?? true;
    const checks = await Promise.all([
      dependencies.idempotencyStore.ready().catch(() => false),
      dependencies.credentialResolver.ready?.().catch(() => false) ?? Promise.resolve(true),
    ]);
    const ready = authorizationServerReady && checks.every(Boolean);
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      // 把原因说出来：否则「一直 not_ready」要靠翻日志才知道是授权服务器不通。
      ...(authorizationServerReady
        ? {}
        : {
            authorization_server: "unreachable",
            detail: dependencies.readiness?.lastError() ?? "validation pending",
          }),
    });
  });

  app.options(config.publicMcpUrl.pathname, (_req, res) => {
    res.status(204).end();
  });
  app.post(
    config.publicMcpUrl.pathname,
    createPreAuthRateLimiter(config),
    requireAuthorizationServerReady(dependencies),
    ensureChallengeScope(),
    requireBearerAuth({
      verifier: dependencies.verifier,
      resourceMetadataUrl,
    }),
    createSubjectRateLimiter(config),
    enforceToolScopes(config, resourceMetadataUrl),
    async (req, res) => {
      if (!req.auth) {
        res.status(401).json({ error: "invalid_token" });
        return;
      }

      let credential: ResolvedCredential;
      try {
        credential = await dependencies.credentialResolver.resolve(req.auth);
      } catch (error) {
        if (error instanceof CredentialResolutionError) {
          // 401 (not 403) on purpose: the bearer token is valid, but the account
          // behind it has no linked credential — re-running the OAuth flow now
          // ensures one at consent time. RFC 6750 clients only re-authorize on
          // 401 + invalid_token, so a 403 here would strand them with a token
          // that can never work until the human intervenes.
          res
            .status(401)
            .set(
              "WWW-Authenticate",
              `Bearer error="invalid_token", error_description="account is not linked to an Atlas Cloud credential; re-authorize to link it", resource_metadata="${resourceMetadataUrl}"`
            )
            .json({
              error: "account_not_linked",
              error_description: error.message,
            });
          return;
        }
        throw error;
      }

      const server = createAtlasCloudServer("remote");
      const baseTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const transport = new OpenAIToolMetadataTransport(baseTransport);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        void transport.close();
        void server.close();
      };
      res.once("close", close);

      try {
        await server.connect(transport);
        await runWithRequestContext(
          {
            authInfo: req.auth,
            subject: credential.subject,
            atlasApiKey: credential.apiKey,
            onCredentialRejected: credential.onRejected,
            idempotencyStore: dependencies.idempotencyStore,
            idempotencyTtlSeconds: config.idempotencyTtlSeconds,
            generationConfirmationSecret:
              config.generationConfirmationSecret,
            generationConfirmationTtlSeconds:
              config.generationConfirmationTtlSeconds,
          },
          () => baseTransport.handleRequest(req, res, req.body)
        );
      } catch (error) {
        close();
        console.error(
          `MCP request failed: ${error instanceof Error ? error.message : "unknown error"}`
        );
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    }
  );
  app.get(
    config.publicMcpUrl.pathname,
    challengeUnauthenticated(resourceMetadataUrl),
    methodNotAllowed
  );
  app.delete(
    config.publicMcpUrl.pathname,
    challengeUnauthenticated(resourceMetadataUrl),
    methodNotAllowed
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  app.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: (error?: unknown) => void
    ) => {
      const status =
        error && typeof error === "object" && "status" in error &&
        typeof error.status === "number"
          ? error.status
          : 500;
      if (status >= 500) {
        console.error(
          `HTTP request failed with status ${status}: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
      if (!res.headersSent) {
        res.status(status).json({
          error: status === 413 ? "request_too_large" : "internal_server_error",
        });
      }
    }
  );
  return app;
}

async function createIdempotencyStore(
  config: HttpServerConfig
): Promise<IdempotencyStore> {
  if (config.idempotencyBackend === "redis") {
    return createRedisIdempotencyStore(config.redisUrl!);
  }
  return new InMemoryIdempotencyStore();
}

export async function startHttpServer(
  env: NodeJS.ProcessEnv = process.env
): Promise<{ server: NodeHttpServer; close: () => Promise<void> }> {
  const config = loadHttpServerConfig(env);
  // 自检不阻塞启动：失败就退出会变成 CrashLoopBackOff，而 k8s 的退避最长到 5 分钟,
  // 授权服务器恢复后还要多等一个周期。改成后台探针 + 就绪门槛，恢复是秒级的，
  // 而且未就绪期间 MCP 端点一律 503，不比退出时更宽松。
  const readiness = startAuthorizationServerProbe(config, {
    onAttemptFailed: (error, attempt, delayMs) => {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(
        `OAuth metadata validation attempt ${attempt} failed (${detail}); retrying in ${delayMs}ms. ` +
          `The server is listening but /readyz reports 503 and the MCP endpoint rejects requests until this passes.`
      );
    },
    onReady: (attempt) => {
      console.error(
        `OAuth authorization server metadata validated${attempt > 1 ? ` after ${attempt} attempts` : ""}; ready.`
      );
    },
  });
  const idempotencyStore = await createIdempotencyStore(config);
  let credentialResolver: AtlasCredentialResolver | undefined;
  let server: NodeHttpServer;
  try {
    credentialResolver = await createConfiguredCredentialResolver(config);
    const dependencies: HttpAppDependencies = {
      readiness,
      verifier: new JwtAccessTokenVerifier(config),
      idempotencyStore,
      credentialResolver,
    };
    const app = createHttpApp(config, dependencies);
    server = await new Promise<NodeHttpServer>((resolve, reject) => {
      const listening = app.listen(config.port, config.listenHost, () => resolve(listening));
      listening.once("error", reject);
    });
  } catch (error) {
    readiness.stop();
    await Promise.allSettled([
      idempotencyStore.close(),
      credentialResolver?.close?.() ?? Promise.resolve(),
    ]);
    throw error;
  }
  console.error(
    `Atlas Cloud MCP HTTPS backend listening on ${config.listenHost}:${config.port} for ${config.publicMcpUrl.toString()}`
  );

  const close = async (): Promise<void> => {
    readiness.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await idempotencyStore.close();
    await credentialResolver?.close?.();
  };
  return { server, close };
}

const invokedAsScript =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  startHttpServer()
    .then(({ close }) => {
      const shutdown = (): void => {
        void close()
          .then(() => process.exit(0))
          .catch((error) => {
            console.error(
              `Graceful shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`
            );
            process.exit(1);
          });
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    })
    .catch((error) => {
      console.error(
        `Fatal HTTP server error: ${error instanceof Error ? error.message : "unknown error"}`
      );
      process.exit(1);
    });
}
