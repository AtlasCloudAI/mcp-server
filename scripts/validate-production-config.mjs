import { loadAuthorizationServerConfig } from "../dist/auth/config.js";
import { loadHttpServerConfig } from "../dist/config.js";
import { validateProductionReleasePair } from "../dist/production-release.js";

const mcp = loadHttpServerConfig(process.env);
const auth = loadAuthorizationServerConfig(process.env);
validateProductionReleasePair(mcp, auth);

console.log(
  "PRODUCTION_CONFIG_VALID",
  `mcp_host=${mcp.publicMcpUrl.hostname}`,
  `auth_host=${auth.issuer.hostname}`,
  `identity=${auth.identityMode}`,
  `credential_mode=${mcp.credentialMode}`,
  `keyring_keys=${mcp.credentialEncryptionKeys.length}`
);
