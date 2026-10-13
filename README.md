# Node + React + Postgres — Production-Style Local Platform

A simple full-stack app (React + Node.js/Express + PostgreSQL) taken through
six stages: containerization, Kubernetes, Ingress/API gateway, CI/CD,
platform services (Redis/queue/search + simulated read/write DB), and
observability/scaling.

## Repo structure

```
.
├── backend/                  # Express API + BullMQ worker
├── frontend/                 # React (Vite) app
├── 
├── 
├── 
├── 
├── k8s/                      # Namespaces, Deployments, Services, Ingress
├── observability/            # Prometheus, Grafana, Fluent Bit, Loki, HPA
└── .github/workflows/ci-cd.yml
```

---

## Task 1 — Local Docker Compose

```bash
docker compose up --build
```

- Frontend: http://localhost:8080
- Backend:  http://localhost:4000/api/health
- Postgres: localhost:5432 (persisted in the `postgres_data` volume)

Both Dockerfiles use multi-stage builds (deps/build stage discarded, only
`node_modules` + source or the compiled static bundle ship in the final
image). No secrets are hardcoded — DB/Redis/search connection info comes from
environment variables (see `docker-compose.yml` and `backend/.env.example`).

## Task 2 — Kubernetes

Requires a local cluster (`kind` or `minikube`) with images built and loaded
(or pushed to a registry the cluster can pull from):

```bash
kubectl apply -f k8s/namespace-dev.yaml
kubectl apply -n dev -f k8s/
```

- `dev` namespace holds everything.
- `backend-service` / `postgres-service` are `ClusterIP` — internal only.
- `frontend-service` is `NodePort` (30080) for direct access; Task 3 adds
  Ingress on top for a friendlier path.
- Postgres uses a `PersistentVolumeClaim` bound to a `hostPath` PV so data
  survives pod restarts.
- `backend` has `readinessProbe`/`livenessProbe` hitting `/api/health/ready`
  and `/api/health/live` respectively — readiness checks the DB is
  reachable, liveness only checks the process is up (so a slow DB doesn't
  cause pointless container restarts).

## Task 3 — Ingress / API Gateway

```bash
# example for kind: install nginx-ingress, then
echo "127.0.0.1 node-react.local" | sudo tee -a /etc/hosts
kubectl apply -n dev -f k8s/ingress-dev.yaml
```

**Request path:** `Browser → Ingress → Service → Pod → PostgreSQL`
1. Browser resolves `node-react.local` to the ingress controller's IP (via
   `/etc/hosts` locally, or real DNS in prod).
2. The Ingress controller matches the path: `/api` or `/api/*` →
   `backend-service`; everything else → `frontend-service`.
3. The Service load-balances across matching pods via `kube-proxy` (or an
   eBPF equivalent).
4. The backend Pod talks to Postgres via `postgres-service`.

**Kubernetes DNS:** every Service gets a stable DNS name of the form
`<service>.<namespace>.svc.cluster.local` — e.g. `backend-service.dev.svc.
cluster.local`. Pods use this name instead of an IP because pod IPs change
on every restart/reschedule; the Service is the stable, load-balanced front
door.

**Debugging:**
- *Ingress reachable but backend is not:* check `kubectl get endpoints
  backend-service -n dev` — empty means the Service's label selector isn't
  matching any Ready pod. Then check backend pod logs and its readiness
  probe status.
- *Frontend can't reach backend:* confirm `VITE_API_BASE_URL` was baked in
  correctly at build time, that the browser's requests are going to `/api/*`
  (not `http://backend-service:4000` — that hostname only resolves inside
  the cluster, not from the browser), and check the Ingress controller logs
  for a 404/502 on that path.

**Evolving to microservices:** the Ingress already acts as a lightweight API
gateway routing by path prefix. Splitting the backend into multiple services
(e.g. `users-service`, `orders-service`) just means adding more path rules
(`/api/users`, `/api/orders`, …) pointing at more ClusterIP Services — the
Ingress, DNS, and probe patterns established here don't change.

## Task 4 — CI/CD & Multi-Environment Deployment

`.github/workflows/ci-cd.yml` triggers on push to:

| Branch pattern      | Target namespace |
|----------------------|-------------------|
| `master`             | `dev`             |
| `pre-release/v*`     | `preprod`         |
| `release/v*`         | `release`         |

Pipeline: install deps → build/validate both services → build Docker images
→ tag as `<branch>-<short-sha>` → push to GHCR → `sed`-patch the k8s
manifests with the new image tag and target namespace → `kubectl apply`.

**Secrets:** the registry push uses the ephemeral, repo-scoped
`GITHUB_TOKEN` — no long-lived registry credentials are stored. Cluster
access uses a base64-encoded kubeconfig stored as an encrypted Actions
secret (`KUBECONFIG_B64`), scoped to a service account limited to the
target namespace(s).

**Rollback:** two options, both included —
1. **Fast:** `kubectl rollout undo deployment/<name> -n <namespace>` (wired
   up as a manual `workflow_dispatch` job in the pipeline) — reverts to the
   previous ReplicaSet immediately.
2. **Precise:** re-run the pipeline against the previous commit/tag, which
   rebuilds and redeploys that exact known-good image — slower, but
   guarantees you're not relying on a ReplicaSet Kubernetes hasn't garbage
   collected yet.

## Task 5 — Platform Services: Redis, Queue, Search, Read/Write DB

Added to both `docker-compose.yml` and `k8s/`:
- **Redis** (`redis-deployment.yaml` / `redis-service.yaml`) — the backend
  connects via `REDIS_URL` (`backend/src/redisClient.js`) and exposes
  `/api/health/redis`.
- **Queue** (`bullmq-worker-deployment.yaml`) — BullMQ over Redis. Every
  `POST /api/items` enqueues an `item-created` job (`backend/src/queue.js`);
  a separate worker process (`backend/src/worker.js`, same image, different
  `command:`) consumes it. Decoupling the worker into its own Deployment
  means it scales and fails independently of the API.
- **Search** (`search-deployment.yaml` / `search-service.yaml`) — OpenSearch
  in single-node dev mode. The backend only does a health call today
  (`backend/src/search.js`, `/api/health/search`) — real indexing would hook
  into the same queue consumer.

**Simulated read/write DB cluster:** `backend/src/db.js` holds two separate
`pg.Pool` instances — `writePool` from `DB_WRITE_URL`, `readPool` from
`DB_READ_URL`. `write()` (INSERT/UPDATE/DELETE) always uses `writePool`;
`read()` (SELECT) uses `readPool`. Locally both env vars point at the same
Postgres instance, but the code already treats them as separate targets, so
pointing `DB_READ_URL` at a real replica later is a one-line config change —
no application code changes.

**Where routing logic lives:** in this repo it's explicit in application
code (`write()` vs `read()` helpers). The alternative is a DB proxy
(PgBouncer, ProxySQL, or a cloud-managed read/write splitter) that makes
routing transparent to the app — simpler application code, but another
component to operate and one more hop of latency.

**Replication lag:** a replica can be milliseconds to seconds behind the
primary. Anything that reads its own recent write — "did my update save?",
a redirect-after-POST that re-fetches the record, uniqueness checks before
an insert — must hit the writer/primary, not a replica, or it risks reading
stale data and behaving as if the write never happened.

## Task 6 — Observability, Scaling & Rate Limiting

`observability/`:
- **Prometheus** (`prometheus.yaml`) scrapes any pod annotated
  `prometheus.io/scrape: "true"` (the backend Deployment is annotated
  accordingly) in the `dev` namespace.
- **Grafana** (`grafana.yaml`) for dashboards on: backend CPU usage, backend
  memory usage, request rate & error rate, and replica count over time.
- **Fluent Bit** (`fluentbit-daemonset.yaml`) runs as a `DaemonSet` (one per
  node, so it picks up every pod's logs on that node regardless of which
  pods get scheduled where) and ships backend logs to **Loki**
  (`loki.yaml`).
- **HPA** (`hpa-backend.yaml`) scales the backend Deployment 2→6 replicas on
  CPU (70%) or memory (80%) utilization.

**What to alert on, and why:**
- **High error rate** (5xx / total requests) — the most direct signal
  something is actually broken for users, independent of load level.
- **High CPU / at max HPA replicas** — means the autoscaler is out of
  headroom; the next symptom is queueing and latency, not just slow scaling.
- **High p95/p99 latency** — catches degradation (slow queries, GC pauses,
  a struggling dependency) that error-rate and CPU alone can miss.
- **Sustained high request rate** without a matching replica increase —
  usually indicates the HPA is misconfigured or capped, not that traffic is
  fine.

**Verifying logs:** `kubectl logs -n dev daemonset/fluent-bit` to confirm
Fluent Bit is running and tailing files, then query Loki (via Grafana's
Explore view, `{job="backend"}`) to confirm entries are actually arriving
and are searchable/filterable by label.
# node-react-postgres-platform
# node-react-postgres-platform
# node-react-postgres-platform
# node-react-postgres-platform
