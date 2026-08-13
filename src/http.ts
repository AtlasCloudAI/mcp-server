#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import type { Server as NodeHttpServer } from "node:http";
import type { Express, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  loadHttpServerConfig,
  type HttpServerConfig,
} from "./config.js";
import {
  createConfiguredCredentialResolver,
  CredentialResolutionError,
  type AtlasCredentialResolver,
} from "./services/credential-resolver.js";
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
  createPreAuthRateLimiter,
  createSubjectRateLimiter,
  enforceExactHost,
  enforceToolScopes,
  restrictedCors,
  securityHeaders,
} from "./http/middleware.js";

export interface HttpAppDependencies {
  verifier: OAuthTokenVerifier;
  idempotencyStore: IdempotencyStore;
  credentialResolver: AtlasCredentialResolver;
}

function protectedResourceMetadata(config: HttpServerConfig): Record<string, unknown> {
  return {
    resource: config.resourceId,
    authorization_servers: [
      config.authorizationServer.toString().replace(/\/$/, ""),
    ],
    scopes_supported: config.scopesSupported,
    bearer_methods_supported: ["header"],
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
    const checks = await Promise.all([
      dependencies.idempotencyStore.ready().catch(() => false),
      dependencies.credentialResolver.ready?.().catch(() => false) ?? Promise.resolve(true),
    ]);
    const ready = checks.every(Boolean);
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready" });
  });

  app.options(config.publicMcpUrl.pathname, (_req, res) => {
    res.status(204).end();
  });
  app.post(
    config.publicMcpUrl.pathname,
    createPreAuthRateLimiter(config),
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

      let credential: { subject: string; apiKey: string };
      try {
        credential = await dependencies.credentialResolver.resolve(req.auth);
      } catch (error) {
        if (error instanceof CredentialResolutionError) {
          res.status(403).json({
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
  app.get(config.publicMcpUrl.pathname, methodNotAllowed);
  app.delete(config.publicMcpUrl.pathname, methodNotAllowed);

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
  await fetchAndValidateAuthorizationServerMetadataWithRetry(config, fetch, {
    onRetry: (error, attempt, delayMs) => {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(
        `OAuth metadata validation attempt ${attempt} failed (${detail}); retrying in ${delayMs}ms`
      );
    },
  });
  const idempotencyStore = await createIdempotencyStore(config);
  let credentialResolver: AtlasCredentialResolver | undefined;
  let server: NodeHttpServer;
  try {
    credentialResolver = await createConfiguredCredentialResolver(config);
    const dependencies: HttpAppDependencies = {
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
