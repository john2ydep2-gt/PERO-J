# Kubernetes Deployment Guide

This guide details how to deploy PERO-J (Soroban Smart Block Explorer) indexer and frontend services onto a Kubernetes cluster.

## Manifest Structure

All Kubernetes resources are located in the `k8s/` directory:

- `k8s/configmap.yaml`: ConfigMap (`pero-config`) holding non-sensitive configuration values.
- `k8s/secret.yaml`: Secret template (`pero-secrets`) holding database connection strings.
- `k8s/indexer-deployment.yaml`: Deployment and Service manifests for the backend indexer.
- `k8s/frontend-deployment.yaml`: Deployment and Service manifests for the frontend UI.
- `k8s/hpa.yaml`: HorizontalPodAutoscaler for frontend autoscaling based on CPU utilization.

## Environment Configuration

### ConfigMap (`k8s/configmap.yaml`)

| Variable | Description | Default |
|---|---|---|
| `SOROBAN_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `HORIZON_URL` | Horizon REST endpoint | `https://horizon-testnet.stellar.org` |
| `NETWORK_PASSPHRASE` | Stellar network passphrase | `Test SDF Network ; September 2015` |
| `ORACLE_CONTRACT_ID` | Deployed Oracle contract ID for `GET /api/v1/oracle/disputes` | (unset; disputes endpoint returns HTTP 503) |
| `ORACLE_COUNCIL_ROSTER` | Comma-separated council Stellar addresses for the inactivity monitor | (unset; monitor disabled) |
| `ORACLE_COUNCIL_QUORUM` | Required council vote count; defaults to a strict majority of the roster | (unset) |
| `PAGERDUTY_ROUTING_KEY` | PagerDuty Events API v2 integration routing key; configure its service escalation policy for the council roster | (unset; monitor disabled) |
| `START_LEDGER` | Starting ledger sequence (0 to auto-resume) | `0` |
| `POLL_MS` | Ingestion poll interval in ms | `5000` |
| `PORT` | API server listen port | `3001` |
| `LAG_ALERT_THRESHOLD_S` | Maximum allowed indexing lag before readiness degrades | `30` |
| `DATABASE_POOL_SIZE` | Maximum PostgreSQL connections in the indexer pool (1-100) | `20` |
| `VITE_API_PROXY` | Proxy target for frontend API requests | `http://indexer:3001` |

### Secrets (`k8s/secret.yaml`)

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL (`postgres://user:password@host:port/dbname`) |

## Health and Readiness Probes

The indexer container exposes two health endpoints:
- **Liveness Probe (`/ready`)**: Verifies basic database connectivity and process liveness.
- **Readiness Probe (`/health`)**: Validates database connectivity as well as indexer lag against `LAG_ALERT_THRESHOLD_S` (returning HTTP 503 if degraded).

## Deploying to Kubernetes

1. **Configure Secrets & ConfigMap**:
   Update `k8s/configmap.yaml` and `k8s/secret.yaml` with your target network and database credentials.

2. **Apply Manifests**:
   ```bash
   kubectl apply -f k8s/
   ```

3. **Verify Deployment**:
   ```bash
   kubectl get pods -l 'app in (indexer,frontend)'
   kubectl get svc
   ```

4. **View Logs**:
   ```bash
   kubectl logs -f deployment/indexer
   kubectl logs -f deployment/frontend
   ```


## Production image hardening

The indexer production image (`indexer/Dockerfile` / `indexer/Dockerfile.indexer`)
is a multi-stage build that produces a minimal, non-root runtime:

- **Stage 1 (deps)** — `node:20-alpine` installs production-only dependencies
  (`npm ci --omit=dev`), strips the transitive `sodium-native` native package
  (~14MB; `@stellar/stellar-base` falls back to the pure-JS `tweetnacl`), and
  prunes docs/test/source-map files from `node_modules` (→ ~16MB of deps).
- **Stage 2 (runtime)** — `node:20-alpine` copies only the production
  `node_modules` and `src/`, and runs as a dedicated non-root `appuser`
  (fixed UID/GID 10001). No dev dependencies, no build tooling, and no shell
  tools (e.g. `curl`) are included in the runtime image.

The resulting image is ~140MB uncompressed (~50MB compressed), under the
150MB production target, and the process never runs as root.

The `k8s/indexer-deployment.yaml` enforces this at the orchestration layer with
a pod `securityContext` (`runAsNonRoot: true`, `runAsUser: 10001`,
`runAsGroup: 10001`, `fsGroup: 10001`) and a container `securityContext`
(`allowPrivilegeEscalation: false`, all Linux capabilities dropped).

> The PERO-J backend is a single Node.js service that serves the REST API,
> polls Soroban RPC, and optionally submits decoded events on-chain (the
> "oracle" role). One production image therefore covers the API, indexer, and
> oracle roles — there are no separate API/oracle services to build distinct
> images for. The indexer is plain JavaScript run directly with `node` (no
> TypeScript compile step).
