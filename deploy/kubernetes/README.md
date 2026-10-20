# Kubernetes manifests

What is here:

- `base/` — the Deployment, Service and Redis every environment starts from.
- `production.example/` — a production overlay with the image pinned by digest.
  `production-patch.yaml` and `drop-auth-app.yaml` show which settings a real
  deployment overrides.
- `staging-upstream-oidc.example/` — a staging variant that logs users in
  through an upstream OIDC provider.
- `production.env.example` — every environment variable the server reads, with
  notes on each.

Render the production example with:

```bash
kubectl kustomize deploy/kubernetes/production.example
```

The manifests that are actually applied to production, the secrets layout and
the operations runbooks are not in this repository. They live in Atlas Cloud's
internal infrastructure repository under `mcp-server/`.
