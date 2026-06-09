# Deploying the EasyParcel MCP server — `mcp.easyparcel.com`

Deploys `ep mcp --http --oauth` to the EasyParcel ACK cluster (Alibaba ALB ingress) as a
remote MCP server with an OAuth 2.1 authorization-server proxy, so ChatGPT (and other MCP
clients) can connect and let each user log in with their own EasyParcel account.

Targets the existing cluster: namespace `default`, ALB ingress `easyparcel-ingress`,
ACR `easyparcel-registry(-vpc).ap-southeast-3.cr.aliyuncs.com/easyparcel-production`.
TLS for `mcp.easyparcel.com` is already covered by the `wildcard.easyparcel.com-tls`
secret on that ingress — no new cert needed.

## 1. Build & push the image to ACR

```bash
# from the repo root. Push via the public ACR endpoint (the cluster pulls the -vpc one).
REG=easyparcel-registry.ap-southeast-3.cr.aliyuncs.com/easyparcel-production
docker login easyparcel-registry.ap-southeast-3.cr.aliyuncs.com    # ACR credentials
docker build -t $REG/easyparcel-mcp:0.1.3 .
docker push  $REG/easyparcel-mcp:0.1.3
```

## 2. Deploy the Deployment + Service

```bash
kubectl apply -k deploy/k8s
kubectl -n default rollout status deploy/easyparcel-mcp
```

## 3. Add the route to the ALB ingress

Append one rule to the existing `easyparcel-ingress` (TLS already handled by the wildcard):

```bash
kubectl patch ingress easyparcel-ingress -n default \
  --type=json --patch-file deploy/k8s/ingress-rule.patch.json
```

## 4. ⚠️ Whitelist the OAuth callback (REQUIRED)

Add `https://mcp.easyparcel.com/oauth/callback` to the **Allowed Redirect URIs** of the CLI
app (client `675a19ed-bb9b-4e88-b3e6-9b1b46ce745c`) — via the Developer Hub, or the SQL in
the project notes. Without it EasyParcel rejects the `/authorize` redirect.

## 5. Verify

```bash
curl https://mcp.easyparcel.com/health
curl https://mcp.easyparcel.com/.well-known/oauth-authorization-server
curl -i -X POST https://mcp.easyparcel.com/mcp -H 'content-type: application/json' -d '{}'
#   -> expect 401 + WWW-Authenticate: Bearer resource_metadata=...
```

## 6. Add to ChatGPT

ChatGPT → Settings → Connectors → Developer mode → Add custom connector →
`https://mcp.easyparcel.com/mcp`. For public listing, submit via OpenAI's Apps process.

## OAuth state store (Redis) & scaling

The OAuth proxy's state — registered clients, pending authorizations and one-time codes — is
persisted in **Redis** via the `EP_MCP_REDIS_URL` env on each deployment. Redis runs **in-cluster**
(`deploy/k8s/redis.yaml`: Deployment + Service + NAS-backed PVC) at the cluster-internal Service
`redis://easyparcel-redis.default.svc.cluster.local:6379` — no external endpoint, IP whitelist or
auth, only reachable on the cluster network.
Keys are namespaced per `--ep-client-id` (`epmcp:<client-id>:{client,pending,code}:*`) so the
ChatGPT / Claude / general deployments share one Redis without colliding. TTLs: clients 30d,
pending/codes 10m. If `EP_MCP_REDIS_URL` is unset the proxy falls back to an in-memory store.

**Why this matters:** previously a rollout/restart wiped the in-memory store, after which MCP
clients (which persist their registered `client_id`) hit `invalid_client / "unknown client_id"`
on `/authorize` until they re-registered. Redis makes registrations durable across deploys.

`replicas: 1` is still set. Redis removes the OAuth-state barrier to scaling, **but** MCP
Streamable-HTTP sessions are held per-pod in memory (the `sessions` map in `src/mcp/http.ts`),
so raising `replicas` also requires **ingress session affinity** (sticky sessions keyed on
`Mcp-Session-Id`/cookie) — otherwise a session opened on one pod 404s on another.
