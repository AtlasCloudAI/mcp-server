#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import type { Server as NodeHttpServer } from "node:http";
import { createAuthorizationApp, listenAuthorizationApp } from "./auth/app.js";
import { loadAuthorizationServerConfig } from "./auth/config.js";
import { createRedisOidcStore } from "./auth/redis-adapter.js";
import { RedisFederatedIdentityStore } from "./auth/federated-store.js";
import { createUpstreamIdentityClient } from "./auth/upstream-oidc.js";
import { validateAtlasCredential } from "./services/credential-validation.js";
import { RedisLinkedAtlasCredentialStore } from "./services/linked-credential-store.js";

export async function startAuthorizationServer(): Promise<{
  server: NodeHttpServer;
  close(): Promise<void>;
}> {
  const config = loadAuthorizationServerConfig();
  const store = await createRedisOidcStore(
    config.redisUrl,
    config.redisPrefix,
    config.dynamicClientTtlSeconds,
    config.refreshTokenReuseGraceSeconds,
    config.refreshTokenReuseMaxAttempts
  );
  let server: NodeHttpServer;
  try {
    const dependencies = config.identityMode === "upstream-oidc"
      ? {
          federatedStore: new RedisFederatedIdentityStore(store.client, config.redisPrefix),
          credentialStore: new RedisLinkedAtlasCredentialStore(
            store.client,
            config.credentialRedisPrefix,
            config.credentialEncryptionKeys
          ),
          upstreamClient: await createUpstreamIdentityClient(config.upstream!),
          validateAtlasCredential,
        }
      : {};
    const { app } = createAuthorizationApp(config, store, dependencies);
    server = await listenAuthorizationApp(app, config);
  } catch (error) {
    await store.close();
    throw error;
  }

  return {
    server,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await store.close();
    },
  };
}

async function main(): Promise<void> {
  const running = await startAuthorizationServer();
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const address = running.server.address();
  const display = typeof address === "object" && address
    ? `${address.address}:${address.port}`
    : String(address);
  console.error(`Atlas Cloud OAuth server listening on ${display}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Atlas Cloud OAuth server failed: ${message}`);
    process.exit(1);
  });
}
