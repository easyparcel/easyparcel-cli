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
docker build -t $REG/easyparcel-mcp:<new-tag> .
docker push  $REG/easyparcel-mcp:<new-tag>
```

`<new-tag>` is the `package.json` version, bumped (with `CLI_VERSION`) in the commit that changes
the code. A tag is never reused. Once the image is pushed and rolled out, move the manifest image
tags and the kustomization `newTag` to it in a commit (on a first deploy, before step 2), so the
manifests never name a tag that is not pushed yet or lag what is running.

## 2. Deploy the Deployment + Service

```bash
kubectl apply -k deploy/k8s
kubectl -n default rollout status deploy/easyparcel-mcp
```

This is for a first deploy. On a running deployment change the image or env in place (see
[Changing a live deployment](#changing-a-live-deployment)).

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

## Tool allow-list per deployment

`EP_MCP_ALLOWED_OPERATIONS` (comma-separated operation ids or tool names) limits which tools a
deployment lists and serves; unset exposes all of them. `easyparcel-mcp-chatgpt` runs with the
read-only set `shipment.quote,shipment.list,shipment.details,shipment.track,shipment.insurance-quote,courier.list,courier.dropoff-points,account.list`
(see `deploy/k8s/chatgpt-deployment.yaml`); the general and Claude brokers expose every tool.
`/health` reports the resulting `tools` count (8 on ChatGPT). An unknown name fails startup, so a typo shows up as a
crash-looping pod rather than a wide-open connector.

`account.list` is in the ChatGPT set because every other tool acts on one shipping account. A
one-account sign-in carries that account in its token, but an "All my shipping accounts" sign-in
must pass `account_id` on each call, and `ep_account_list` is the only tool that returns the ids.

The list is exact: the server never adds a tool to it. If it exposes an account-scoped tool
without `account.list` (or an organization-scoped tool without `organization.list`), the server
still starts and logs one line, `warning: EP_MCP_ALLOWED_OPERATIONS leaves out account.list: …`,
so an edit that strands all-accounts sign-ins shows up in the pod log (image 0.1.13 and later).

## Changing a live deployment

Change env and image on the running Deployment; do not re-apply the manifests to do it:

```bash
kubectl -n default set env deployment/easyparcel-mcp-chatgpt -c mcp EP_MCP_ALLOWED_OPERATIONS=<list>
kubectl -n default set image deployment/easyparcel-mcp-chatgpt mcp=easyparcel-registry-vpc.ap-southeast-3.cr.aliyuncs.com/easyparcel-production/easyparcel-mcp:<tag>
kubectl -n default rollout status deploy/easyparcel-mcp-chatgpt
```

Never `kubectl apply` a manifest whose image tag is older than the one running. Check the live tag
first with `kubectl -n default get deploy <name> -o jsonpath='{.spec.template.spec.containers[?(@.name=="mcp")].image}'`.
An older image silently drops behaviour the connectors rely on: 0.1.10 ignores
`EP_MCP_ALLOWED_OPERATIONS` (ChatGPT would get every tool, the mutating ones included) and does not
forward `X-Account-Id`. A pushed tag is never rebuilt with different content (`imagePullPolicy:
IfNotPresent` keeps whatever a node already pulled), so a code change always ships as a new tag.
MCP sessions are per pod, so open chats need to reconnect after a rollout.

## OAuth state store (Redis) & scaling

The OAuth proxy's state — registered clients, pending authorizations and one-time codes — is
persisted in **Redis** via the `EP_MCP_REDIS_URL` env on each deployment. Redis runs **in-cluster**
(`deploy/k8s/redis.yaml`: Deployment + Service + NAS-backed PVC) at the cluster-internal Service
`redis://easyparcel-redis.default.svc.cluster.local:6379` — no external endpoint, IP whitelist or
auth, only reachable on the cluster network.
Keys are namespaced per `--ep-client-id` (`epmcp:<client-id>:{client,pending,code}:*`) so the
ChatGPT / Claude / general deployments share one Redis without colliding. TTLs: clients ~10 years
(slid forward on every `/authorize`; `EP_MCP_SEED_CLIENTS` entries 1 year, re-seeded on boot),
pending/codes 10m. If `EP_MCP_REDIS_URL` is unset the proxy falls back to an in-memory store.

**Why this matters:** previously a rollout/restart wiped the in-memory store, after which MCP
clients (which persist their registered `client_id`) hit `invalid_client / "unknown client_id"`
on `/authorize` until they re-registered. Redis makes registrations durable across deploys.

`replicas: 1` is still set. Redis removes the OAuth-state barrier to scaling, **but** MCP
Streamable-HTTP sessions are held per-pod in memory (the `sessions` map in `src/mcp/http.ts`),
so raising `replicas` also requires **ingress session affinity** (sticky sessions keyed on
`Mcp-Session-Id`/cookie) — otherwise a session opened on one pod 404s on another.
