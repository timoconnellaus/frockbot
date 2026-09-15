# Kubernetes Computer host plan

**Status:** chosen direction for the next Computer host implementation.

**Initial target:** at most five Users on one self-managed DigitalOcean node.

**Expansion target:** add cheaper Hetzner capacity without changing the product-facing Computer contract. Tailscale is the preferred private operator network and the first cross-cloud transport to test, but the production cluster must not depend on k3s's experimental Tailscale integration until it passes the expansion gate in [Phase 4](#phase-4-prove-the-hetzner-expansion-path).

This plan supersedes the provider recommendation in [`research/computer-host-options.md`](research/computer-host-options.md). That report remains useful as research history; this document records the decision.

Sources and prices were checked on 15 September 2026.

### Decision record — 15 September 2026

The initial node is the **US$48/month 4 shared vCPU / 8 GiB / 160 GiB Basic Droplet**, not the US$96/month 8 vCPU / 16 GiB shape first considered. The five-User pilot is deliberately oversubscribed because Computers are expected to be idle or lightly loaded most of the time. A hard admission cap, staged User rollout and measured resize triggers bound that bet. The US$96 node is the first vertical upgrade, not the starting point.

---

## 1. Decision

Build a third `ComputerHostV1` implementation on Kubernetes using [`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox). Start with:

- one DigitalOcean Basic Droplet, 4 shared vCPU, 8 GiB RAM and 160 GiB SSD;
- one single-server k3s cluster, with that server also acting as the worker;
- one always-running, gVisor-isolated `Sandbox` per User;
- a 20 GiB DigitalOcean block volume per User;
- provider-neutral encrypted workspace backups in R2;
- Cloudflare Tunnel for application and viewer ingress;
- host-level Tailscale for private administration; and
- a hard admission cap of five Computers.

Do not introduce Kubernetes concepts above `ComputerHostV1`. The app continues to see one Computer per User and the existing per-Bot desktop slots inside it.

This first deployment deliberately accepts a single-node failure domain. It is a five-User product pilot, not a highly available cluster. A node outage restarts Computers after repair or replacement; it must not lose acknowledged turns or the latest successfully backed-up files.

---

## 2. Why this shape

The 8 GiB Basic Droplet is the cheapest plausible five-User pilot shape in DigitalOcean's bundled catalog: 4 shared vCPUs, 8 GiB RAM and 160 GiB disk for **US$48/month**. It relies on low simultaneous utilization and must be validated one admitted User at a time. The 16 GiB / 8 vCPU / 320 GiB **US$96/month** shape is the immediate resize when the measured triggers below fire. [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)

Kubernetes is not being adopted as a new product control plane. It is an implementation detail of the existing Computer Package. FrockBot's Durable Objects remain authoritative for Users, Bots, turns, leases, audit and workspace generations. Kubernetes owns only the desired and observed runtime state of Computers.

The initial node is intentionally self-managed instead of DOKS because:

- DOKS's free control plane would be operationally convenient but does not expose a supported way to install the gVisor runtime required by this workload;
- self-management permits a pinned k3s, containerd and gVisor configuration; and
- the same configuration can later be installed on Hetzner bare-metal workers.

`agent-sandbox` is used for the singleton Sandbox lifecycle, stable identity, claims/templates and PVC attachment. It does not become the authority for accepted User work.

---

## 3. Initial topology

```text
Browser / native client
        |
        v
Cloudflare app Worker + Durable Objects
        |
        | authenticated ComputerHost v1 requests
        v
Cloudflare Tunnel: computer-host.<domain>
        |
        v
DigitalOcean Droplet
  - cloudflared (host service)
  - tailscaled (host service, administration only)
  - k3s server + worker
  - gVisor / runsc RuntimeClass
  - Agent Sandbox controller
  - Computer host gateway
  - up to five per-User Sandboxes
        |
        +-- one 20 GiB DO volume per User
        +-- encrypted incremental backup to R2
```

Use the DigitalOcean region nearest the initial interactive Users. If those Users are not regionally concentrated, measure browser-viewer latency before provisioning. Do not choose Frankfurt merely to anticipate Hetzner: a future distant Hetzner fleet can be a separate cluster. If a Hetzner worker is to join this exact cluster, its region and the DigitalOcean control plane must first demonstrate acceptable round-trip time in Phase 4.

No DigitalOcean load balancer is required for the single-node pilot. `cloudflared` creates outbound connections to Cloudflare and provides the stable public host. Kubernetes API access and SSH are not published through that tunnel; they remain private over Tailscale.

---

## 4. Capacity and cost

### Resource envelope

Each Computer begins with:

| Resource | Request | Limit |
| --- | ---: | ---: |
| CPU | 150 millicores | 2 vCPU |
| Memory | 768 MiB | 2.5 GiB |
| Persistent workspace | 20 GiB | 20 GiB initially |

Five Computers therefore reserve 0.75 vCPU and 3.75 GiB RAM while retaining burst access to the node. The remaining memory is for k3s, the Agent Sandbox controller, the host gateway, `cloudflared`, `tailscaled`, gVisor overhead, filesystem cache and bursts.

CPU and memory limits are intentionally oversubscribed: five Computers may request up to 10 vCPU and 12.5 GiB on a 4 vCPU / 8 GiB node. Those limits are ceilings, not simultaneously available capacity. A Computer crossing 2.5 GiB may be OOM-killed, and node memory pressure may evict a Computer even below its limit. Before each admission, measure peak and steady-state memory from real Chromium and tool workloads.

Resize to the US$96 16 GiB node before admitting another User if any of these occurs under ordinary use:

- the node reports `MemoryPressure`;
- a Computer is OOM-killed or evicted for memory;
- available node memory remains below 1 GiB for five minutes;
- total memory remains above 80% for 15 minutes; or
- interactive latency becomes unacceptable when two or more Computers are active.

### Monthly starting cost

| Item | Cost |
| --- | ---: |
| DigitalOcean Basic 4 vCPU / 8 GiB / 160 GiB Droplet | US$48 |
| Five 20 GiB DigitalOcean volumes at $0.10/GiB-month | US$10 |
| DigitalOcean load balancer | $0 |
| Tailscale Standard, one operator seat | US$8 if not already paid |
| R2 backup storage and operations | usage-based; expected to be small initially |
| **Infrastructure subtotal** | **US$58/month plus R2** |
| **Subtotal including one new Tailscale Standard seat** | **US$66/month plus R2** |

At all five User slots occupied, the fixed subtotal is **US$11.60 per provisioned User per month**, or **US$13.20** including a new Tailscale seat. This excludes model calls, taxes, backup growth and outbound bandwidth beyond included allowances.

DigitalOcean block storage is currently $0.10/GiB-month. Volumes remain independent from a Droplet and can move between Droplets in the same datacenter, but cannot attach to Hetzner. [DigitalOcean volume pricing](https://docs.digitalocean.com/products/volumes/details/pricing/)

Tailscale's Personal plan is not intended for commercial use. Standard is currently $8 per operator seat per month and includes tagged infrastructure resources within its published allowance. FrockBot Users do not join the tailnet and do not consume seats. [Tailscale pricing](https://tailscale.com/pricing)

---

## 5. Computer placement and identity

One `Sandbox` represents one User Computer. Its Kubernetes names must be derived from a non-secret hash of `ComputerIdentityV1`, never from an email address or raw User id.

Keep a provider-neutral placement record outside Kubernetes:

```text
computer identity
  -> host provider
  -> cluster id
  -> namespace / Sandbox name
  -> storage generation
  -> runtime image generation
```

The initial placement always resolves to the one DigitalOcean cluster. The record exists now so a later migration changes a placement atomically instead of changing the Computer's identity.

Kubernetes labels should include bounded opaque forms of:

- Computer identity;
- deployment/environment;
- runtime generation; and
- storage generation.

Do not put credentials, raw User ids or Bot ids in labels, annotations, pod environment variables or image names.

### Admission

The Computer host gateway owns the five-Computer admission cap. Creating a sixth Computer must return a typed capacity result before creating a PVC or Sandbox. Existing Computers always win over new admissions.

The Kubernetes scheduler still receives honest memory and CPU requests; the application-level cap is an additional commercial and safety fence, not a substitute for scheduling.

---

## 6. Kubernetes implementation

### Host

Use a pinned supported Linux release and a pinned k3s channel. Provision the node reproducibly with Terraform plus cloud-init or an equivalent bootstrap script. No production state may exist only in an interactive shell history.

The host installation owns:

- OS updates and reboot policy;
- k3s and containerd configuration;
- gVisor installation and `RuntimeClass` registration;
- `tailscaled` and `cloudflared` as system services;
- firewall rules;
- node monitoring; and
- encrypted etcd and infrastructure backups.

### Sandbox template

The `SandboxTemplate` must specify:

- `runtimeClassName: gvisor`;
- the resource request and limit envelope above;
- one per-User PVC mounted at the declared persistent paths;
- no `hostPath`, host PID, host IPC or host network;
- no privileged containers;
- a read-only base image where practical;
- dropped Linux capabilities except those proven necessary;
- a default-deny network policy for private/control-plane destinations;
- no cloud metadata access;
- a service account with no Kubernetes API authority; and
- no provider or backup credentials inside the untrusted Computer container.

The first image should carry the current desktop stack rather than provisioning it interactively on first open. Image generation replaces Fly's five-phase machine provisioning digest.

Keep one browser and screen per User with the existing per-Bot slots unless the prototype disproves that model. Changing the sharing model is a separate product decision and must not leak into this host implementation.

### Always-on lifecycle

Do not configure inactivity deletion or scale-to-zero. A provisioned Computer remains scheduled until an authenticated teardown or an operational repair replaces it. A pod restart is allowed; loss of its PVC is not.

`agent-sandbox` provides optional persistent storage but does not promise preservation of process or memory state. The product contract is therefore:

> A Computer retains its identity, declared persistent files and accepted work after a restart or migration. Interactive connections may reconnect and running processes may restart.

---

## 7. Application integration

Implement `computer/kubernetes` beside `computer/fly`.

The new implementation must satisfy the existing `computer/host-contract.test.ts` suite. Add it as a third host entry; do not add Kubernetes-specific assertions to the provider-neutral contract.

The Kubernetes host consists of two parts:

1. **Cloudflare-side client.** Implements `ComputerHostV1`, speaks the existing v1 host protocol over authenticated HTTPS, reports Kubernetes viewer origins and is selected only in `apps/cloudflare/src/computer-host.ts`.
2. **Cluster gateway.** Resolves a User identity to its Sandbox, reconciles creation, forwards file/exec/browser/control operations, issues viewer sessions and performs teardown.

Reuse the existing host protocol and its `x-frockbot-host-token` authentication initially. Rotate to scoped short-lived requests later only as a deliberate protocol revision. The Cloudflare Tunnel must still terminate at a gateway that checks this token; possession of the tunnel hostname is not authority.

Update `scripts/check-computer-host-imports.ts` so Kubernetes vocabulary and dependencies stay under `computer/kubernetes`, its gateway application, the deployment chooser and test rigs. Existing Fly code remains intact until the Kubernetes implementation passes the contract and production pilot.

### Viewer

Serve the current noVNC-compatible viewer through a stable Cloudflare hostname and signed, short-lived session paths. The gateway maps the session to the User's Sandbox. It must support WebSocket upgrades, revoke expired sessions and expose only origins declared by `ComputerHostCapabilitiesV1` for CSP.

Do not publish per-pod, per-node or Tailscale addresses to clients.

---

## 8. Network boundaries

### Product traffic

Product traffic uses Cloudflare Tunnel:

```text
app Worker -> HTTPS hostname -> Cloudflare Tunnel -> host gateway -> Sandbox
client viewer -> HTTPS/WSS hostname -> Cloudflare Tunnel -> viewer gateway -> Sandbox
```

This keeps the origin off the public Internet and gives the application one stable origin across later node changes.

### Operator traffic

Tailscale is installed directly on the host, outside Kubernetes. It is used for:

- SSH;
- Kubernetes API access;
- metrics/debug endpoints; and
- later, a controlled cross-cloud connectivity experiment.

Use tagged non-human nodes and least-privilege grants. The provisioning credential is injected once and is not committed to the repository, baked into an image or made available to Sandbox pods. Restrict the Kubernetes API and SSH to the operator identities that require them.

### Tailscale stability decision

Host-level Tailscale is suitable for the initial deployment and is not in the product request path. Its failure must not stop an already-running Computer from serving through Cloudflare Tunnel.

K3s's built-in Tailscale VPN provider is currently documented as **experimental**, despite being available since the Kubernetes 1.25-1.27 era. K3s supports remote agents and documents the required pod-CIDR approval and ACL rules, but this integration is not admitted directly to production. [K3s distributed/multicloud documentation](https://docs.k3s.io/networking/distributed-multicloud)

---

## 9. Persistence, backup and recovery

### Live storage

Give every Computer its own 20 GiB ReadWriteOnce DigitalOcean PVC. Mount every path whose contents users reasonably expect to survive, including:

- the User home directory;
- workspace files;
- Chromium profile;
- user-installed tools under designated persistent prefixes; and
- shell configuration and history.

Do not claim that arbitrary writes elsewhere in the container root survive. The image owns system packages; the PVC owns declared mutable state.

### Provider-neutral backup

DigitalOcean storage is not the migration format. A trusted sidecar or gateway-controlled job creates encrypted incremental backups in R2 without exposing R2 credentials to the sandboxed process.

Minimum policy for the pilot:

- incremental backup after each settled Computer-using Turn;
- periodic backup at least hourly while files are changing outside Turns;
- cleanly stop Chromium before a consistency-sensitive profile snapshot when possible;
- retain enough generations to recover from silent browser-profile corruption;
- record the successfully stored backup generation in authoritative durable state; and
- run a restore drill before admitting the first pilot User.

The initial recovery objectives are:

- **RPO:** at most one hour of out-of-turn filesystem changes, and no loss after a recorded turn-boundary backup;
- **RTO:** 30 minutes after a complete node replacement; and
- accepted turns survive independently through the Bot Durable Object.

These are targets to measure, not assumptions to advertise before the drills pass.

### Single-node failure

If the node fails but its DigitalOcean volumes remain available:

1. create the replacement node from infrastructure code;
2. reinstall the pinned runtime;
3. attach the existing PVCs;
4. recreate the Sandbox resources;
5. verify each Computer; and
6. repoint Cloudflare Tunnel if its connector identity changed.

If a volume is unavailable or corrupt, restore its last successful R2 generation to a new volume. Processes restart in both cases.

---

## 10. Security boundary

gVisor is necessary but not sufficient. The pilot is not ready until it proves all of the following:

- every User pod actually runs under the expected `RuntimeClass`;
- a Sandbox cannot reach the Kubernetes API, node services, cloud metadata, RFC 1918 infrastructure or another User's pod/PVC;
- no Sandbox can acquire the host gateway, Cloudflare, DigitalOcean, Tailscale, registry or R2 credentials;
- pod security rules reject privileged, host-network and host-mounted variants;
- image digests, not mutable tags, select the runtime shipped to Users;
- viewer and host operations require expiring or rotation-capable authorization;
- teardown is idempotent and deletes the intended Sandbox/PVC only; and
- audit records tie every external Computer operation to its existing effect id.

Start with deny-by-default egress to private and control-plane ranges. General Internet access, if enabled for the Computer product, must pass through a controlled egress boundary that blocks infrastructure destinations and attaches credentials server-side rather than injecting them into the Sandbox.

---

## 11. Delivery phases

### Phase 1 — infrastructure proof

Provision one disposable DO node and prove:

- reproducible k3s and gVisor installation;
- `agent-sandbox` creates a persistent gVisor Sandbox;
- restart preserves the PVC and loses only process state;
- Tailscale-only SSH and Kubernetes API administration;
- Cloudflare Tunnel reaches a test gateway without a public origin port; and
- uninstall/rebuild from the repository is documented and repeatable.

Do not connect production FrockBot or migrate a real Computer in this phase.

### Phase 2 — host implementation

Build the Kubernetes client and gateway, then pass:

- the provider-neutral Computer host contract suite;
- real exec, Workspace, screenshot, browser and background-process operations;
- signed viewer creation, renewal and revocation;
- idempotent open and teardown;
- five-Computer admission; and
- interrupted/retried operation tests using the same effect id.

### Phase 3 — five-User pilot

Before admitting Users:

- complete the isolation tests in section 10;
- complete node-loss and R2 restore drills;
- confirm backups do not corrupt a Chromium profile over at least 20 cycles;
- measure cold pod restart and viewer reconnect time;
- measure per-Computer idle and burst memory;
- alert on node disk, memory pressure, pod restart loops, backup age, tunnel health and certificate expiry; and
- document rollback to Fly while the old implementation still exists.

Admit one User first. Increase the cap one at a time to five only after the prior density is stable. Do not raise the cap on this node without a measured capacity review.

### Phase 4 — prove the Hetzner expansion path

Create a disposable Hetzner worker with the same pinned containerd/gVisor/runtime image and join a non-production cluster over Tailscale.

The preferred experiment is k3s's native Tailscale VPN provider because it handles node and pod routes together. It may graduate into the production stretched cluster only after:

- at least seven days of continuous connection;
- direct and relayed-path tests;
- control-plane restart and Tailscale restart tests;
- packet-loss, MTU and throughput tests;
- pod-to-pod and DNS tests across providers;
- successful Sandbox rescheduling onto Hetzner;
- a simulated DO-to-Hetzner User migration from an R2 backup; and
- confirmation that a control-plane partition leaves running Computers reachable and recovers reconciliation cleanly.

If the experimental integration fails this gate, choose one of two fallbacks:

1. k3s's supported WireGuard-native multicloud network with Tailscale retained for administration; or
2. a separate Hetzner k3s cluster behind the same provider-neutral placement controller.

Prefer the separate-cluster fallback if latency is high, users span distant regions, or Hetzner grows beyond a small adjunct. A stretched cluster is a cheap transitional topology, not a permanent requirement.

---

## 12. Migration contract

Adding Hetzner must not require changing User-facing Computer identity or URLs.

Migration is a controlled restart, not live VM migration:

1. provision and warm the destination Sandbox;
2. pre-copy the latest provider-neutral backup;
3. finish the current Turn;
4. fence new writes on the source with a single-writer lease;
5. capture and restore the final delta;
6. health-check the destination;
7. atomically update placement;
8. reconnect the viewer and resume queued work; and
9. retain the source briefly for rollback before teardown.

The User may observe a reconnect and running processes may restart. Conversation state, accepted work and declared persistent files must survive. Inactive Users should be migrated first because their cutover can be effectively invisible.

---

## 13. Explicit non-goals

The first implementation does not provide:

- control-plane or node high availability;
- live migration of RAM, processes or network connections;
- automatic Hetzner provisioning;
- a distributed cross-cloud filesystem;
- more than five admitted Computers;
- per-User Kubernetes clusters or VMs;
- Kubernetes authority over conversation or turn state; or
- removal of the Fly implementation before rollback has been proven.

---

## 14. Decisions that remain local to implementation

The implementing session may choose these without reopening the architecture:

- Terraform module layout and pinned Linux distribution;
- exact k3s patch version;
- namespace names and hashed resource-name format;
- CNI details for the single-node phase;
- backup tool, provided it produces encrypted provider-neutral generations in R2;
- observability stack, provided the required alerts exist; and
- whether the cluster gateway runs as a Deployment or a host service.

It must stop for a new decision before changing:

- one Computer per User;
- the five-Computer admission cap;
- gVisor as the Sandbox runtime;
- 20 GiB isolated per-User live storage;
- the restartable-process migration contract;
- Cloudflare Tunnel for product ingress;
- Tailscale as the operator network;
- Durable Objects as the authority for accepted work; or
- the requirement that Hetzner be substitutable without changing `ComputerHostV1`.

---

## 15. Definition of done

The five-User DigitalOcean pilot is ready when:

1. A fresh node can be created from repository-held infrastructure definitions without manual mutation.
2. Five gVisor Sandboxes can remain resident simultaneously under the declared requests and limits.
3. The Kubernetes implementation passes the existing Computer host contract and real browser/viewer tests.
4. Rebooting the node preserves every PVC and restores service within the measured RTO.
5. Replacing the node from scratch succeeds using both existing volumes and, separately, an R2 restore.
6. A malicious Sandbox test cannot reach another User, Kubernetes, the node, cloud metadata or infrastructure credentials.
7. Cloudflare Tunnel is the only product ingress and Tailscale is the only administrative ingress.
8. Cost and capacity telemetry can attribute live Computers and reject a sixth admission.
9. The User-visible restart/reconnect behavior matches the migration contract.
10. Fly remains a tested rollback until an explicit later decision removes it.
