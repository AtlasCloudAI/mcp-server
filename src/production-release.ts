import type { AuthorizationServerConfig } from "./auth/config.js";
import type { HttpServerConfig } from "./config.js";

function sameKeyring(
  left: HttpServerConfig["credentialEncryptionKeys"],
  right: AuthorizationServerConfig["credentialEncryptionKeys"]
): boolean {
  return left.length === right.length && left.every((key, index) => {
    const peer = right[index];
    return peer?.kid === key.kid && peer.key.equals(key.key);
  });
}

export function validateProductionReleasePair(
  mcp: HttpServerConfig,
  auth: AuthorizationServerConfig
): void {
  if (mcp.releaseTier !== "production" || auth.releaseTier !== "production") {
    throw new Error("Both MCP and Auth must use PLUGIN_RELEASE_TIER=production");
  }
  if (mcp.credentialMode !== "redis-subject-map") {
    throw new Error("Production MCP must use Redis-encrypted subject credentials");
  }
  if (auth.identityMode !== "upstream-oidc" || !auth.upstream) {
    throw new Error("Production Auth must use an upstream OIDC identity provider");
  }
  if (mcp.publicMcpUrl.toString() !== auth.resource.toString()) {
    throw new Error("MCP public URL and Auth resource URL do not match");
  }
  if (
    mcp.authorizationServer.toString().replace(/\/$/, "") !==
    auth.issuer.toString().replace(/\/$/, "")
  ) {
    throw new Error("MCP authorization issuer and Auth issuer do not match");
  }
  if (mcp.jwksUri.toString() !== new URL("/jwks", auth.issuer).toString()) {
    throw new Error("MCP JWKS URL does not match the Auth issuer JWKS endpoint");
  }
  if (mcp.redisUrl !== auth.redisUrl) {
    throw new Error("MCP and Auth must use the same protected Redis instance");
  }
  if (mcp.credentialRedisPrefix !== auth.credentialRedisPrefix) {
    throw new Error("MCP and Auth credential Redis prefixes do not match");
  }
  if (!sameKeyring(mcp.credentialEncryptionKeys, auth.credentialEncryptionKeys)) {
    throw new Error("MCP and Auth credential encryption keyrings do not match exactly");
  }
}
