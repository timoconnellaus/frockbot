# Incus Computer host plan

**Status:** chosen direction for the next Computer host implementation.

**Shape:** one always-running Incus virtual machine per User, on a small pool of Vultr VX1 hosts with local NVMe, deliberately oversubscribed and rebalanced by live migration.

Prices and provider facts were checked on 19 September 2026.

---

## 1. Decision

Build `computer/incus`, a new `ComputerHostV1` implementation beside `computer/fly`. It runs:

- one QEMU/KVM system VM per User, managed by Incus;
- on Vultr VX1 Cloud Compute hosts, using local NVMe for VM disks;
- with encrypted, provider-neutral workspace backups in R2;
- Cloudflare Tunnel for application and viewer ingress;
- host-level Tailscale for private administration; and
- an Incus cluster whose rebalancer live-migrates VMs between hosts when load crosses a conservative threshold.

Nothing about Incus rises above `ComputerHostV1`. The app continues to see one Computer per User and the existing per-Bot desktop slots inside it. Fly stays in place as the tested rollback until the Incus host passes the contract suite and the pilot.

---

## 2. Always on

A Computer is always running. A User may leave a process running and it must keep executing: a stopped, suspended, paused or cold Computer does not meet the contract, even if its disk or memory can be restored later. There is no scale-to-zero and no inactivity shutdown. A provisioned Computer runs until an authenticated teardown or an operational repair replaces it.

Because every Computer is resident, managed scale-to-zero products (Sprites, Daytona, E2B) lose their economic advantage, and a fixed host we fill densely is the cheapest honest way to provide this.

The product contract is:

> A Computer retains its identity, declared persistent files and accepted work across a host restart or failure. A planned move between hosts keeps its processes, browser session and viewer connection. After an unplanned host failure, interactive connections reconnect and processes restart.

---

## 3. Why this shape

The workload is a real Linux desktop per User, running untrusted code, continuously. That makes an independent guest kernel valuable and rules out anything that sleeps.

**Why a VM manager rather than containers.** A hardware VM boundary is the right isolation for untrusted code from several Users on one machine.

**Why Incus rather than building on Firecracker.** Firecracker supplies only the VMM. FrockBot would have to build the guest agent, supervisor, networking, storage, placement, snapshots and migration itself. Incus is a complete system-VM manager: images, networks, storage pools, snapshots, CPU and memory limits changed live, and live migration of a running VM across hosts with **non-shared** storage. Its cluster rebalancer compares member load and live-migrates suitable VMs past a configured threshold ([instance options](https://linuxcontainers.org/incus/docs/main/reference/instance_options/), [non-shared-storage migration](https://linuxcontainers.org/incus/docs/main/api-extensions/#migration-vm-live), [cluster rebalancing](https://linuxcontainers.org/incus/docs/main/howto/cluster_manage/)). QEMU's larger device surface is managed by running it unprivileged under AppArmor, namespaces, cgroups and seccomp, which Incus does.

**Why Vultr VX1.** Running VMs needs KVM on the host. Ordinary Vultr Cloud Compute cannot use KVM, but VX1 dedicated-CPU instances explicitly support customer virtualization, offer local NVMe, and are available in Sydney ([VX1 features](https://docs.vultr.com/vultr-vx1-cloud-compute), [VX1 provisioning](https://docs.vultr.com/products/compute/instances/vx1-cloud-compute/provisioning)). Hetzner Cloud forbids nested virtualization; Hetzner bare metal is Europe-only.

---

## 4. Hosts and storage

### Host shape

Candidate plans, from Vultr's public Plans API:

| Plan                         | vCPU | RAM    | Local NVMe | Price/month |
| ---------------------------- | ---: | ------ | ---------: | ----------: |
| `vx1-g-4c-16g` (local NVMe)  |    4 | 16 GiB |     240 GB |     $111.69 |
| `vx1-m-4c-32gb` (local NVMe) |    4 | 32 GiB |     240 GB |     $140.89 |

The host size is chosen from the proof measurements in §9, not assumed.

### Local NVMe, not block storage

At the same 240 GB, local NVMe costs $0.09/month more than the equivalent plan plus NVMe Block storage. It is far faster: one independent 4 vCPU/16 GiB VX1 run measured about 327,000 4 KiB IOPS, against Vultr's published NVMe Block ceiling of 10,000 IOPS or 400 MB/s per volume and roughly 3 ms small-I/O latency ([Block benchmark](https://docs.vultr.com/products/storage/block-storage/storage-performance-block-storage)). With every User VM on one host sharing a Block volume, two or three concurrent package installs or builds would hit that shared cap. Incus per-VM I/O limits stop one noisy User taking the whole allowance, but cannot raise it.

Local disks do not survive a lost host. Durability comes from off-host backups (§6), and planned moves use Incus non-shared-storage live migration. Automatic Incus healing needs shared storage and fencing, so it is not used; a failed host is recovered from backup.

### Oversubscription

Each Computer begins with a 2.5 GiB memory envelope. Hosts are deliberately oversubscribed on CPU on the expectation that few Users are busy at once. Rebalancing is what keeps that bet safe: when a host runs hot, Incus moves a VM rather than letting it contend. Rebalancer thresholds and cooldowns start conservative and are tuned from telemetry.

---

## 5. Placement and identity

Incus instance names derive from a non-secret hash of `ComputerIdentityV1`, never from an email address or raw User id. No credentials, raw User ids or Bot ids go into instance names, config keys, metadata or images.

Keep a provider-neutral placement record outside Incus:

```text
computer identity
  -> host provider
  -> Incus cluster id
  -> instance name
  -> storage generation
  -> image generation
```

The gateway owns an admission cap sized from measured capacity. Creating a Computer past it returns a typed capacity result before creating any instance. Existing Computers always win over new admissions.

---

## 6. Persistence, backup and recovery

The VM image owns system packages. Declared persistent paths own mutable state, and only they are promised to survive a rebuild:

- the User home directory;
- workspace files;
- the Chromium profile;
- user-installed tools under designated persistent prefixes; and
- shell configuration and history.

A trusted host-side job creates encrypted incremental backups in R2; the guest never holds R2 credentials. Minimum policy:

- an incremental backup after each settled Computer-using Turn;
- a periodic backup at least hourly while files change outside Turns;
- Chromium stopped cleanly before a consistency-sensitive profile snapshot when possible;
- enough generations retained to recover from silent browser-profile corruption;
- the stored backup generation recorded in authoritative durable state; and
- a restore drill before admitting the first User.

Targets to measure, not to advertise until the drills pass: at most one hour of out-of-turn filesystem changes lost on a host failure, nothing lost after a recorded turn-boundary backup, and 30 minutes to restore a failed host's Computers elsewhere. Accepted turns survive independently in the Bot Durable Object.

VM memory is continuity state, never the authoritative backup.

---

## 7. Application integration

`computer/incus` has two parts:

1. **Cloudflare-side client.** Implements `ComputerHostV1`, speaks the existing v1 host protocol over authenticated HTTPS, reports its viewer origins, and is selected only in `apps/cloudflare/src/computer-host.ts`.
2. **Host gateway.** Resolves a User identity to its VM, reconciles creation, forwards file, exec, browser and control operations to a guest agent, issues viewer sessions and performs teardown.

It must pass the existing `computer/host-contract.test.ts` suite as a new host entry, with no Incus-specific assertions added to the provider-neutral contract. Reuse the v1 protocol and its `x-frockbot-host-token` authentication; the tunnel terminates at a gateway that checks the token, since possessing the hostname is not authority. Update `scripts/check-computer-host-imports.ts` so Incus vocabulary stays under `computer/incus`, its gateway, the deployment chooser and test rigs.

The VM image carries the current desktop stack rather than provisioning it on first open. Keep one browser and screen per User with the existing per-Bot slots.

### Viewer

Serve the noVNC-compatible viewer through a stable Cloudflare hostname and signed, short-lived session paths. The gateway maps the session to the User's VM, supports WebSocket upgrades, revokes expired sessions, and exposes only the origins declared by `ComputerHostCapabilitiesV1`. Per-host, per-VM and Tailscale addresses are never published to clients.

---

## 8. Network and security boundaries

Product traffic:

```text
app Worker -> HTTPS hostname -> Cloudflare Tunnel -> host gateway -> VM
client viewer -> HTTPS/WSS hostname -> Cloudflare Tunnel -> viewer gateway -> VM
```

Operator traffic (SSH, the Incus API, metrics) goes only over host-level Tailscale, with tagged non-human nodes and least-privilege grants. Users never join the tailnet. A Tailscale failure must not stop a running Computer serving through the tunnel.

The pilot is not ready until it proves:

- a VM cannot reach the Incus API, host services, cloud metadata, private or control-plane ranges, or another User's VM or disk;
- no VM can acquire gateway, Cloudflare, Vultr, Tailscale, registry or R2 credentials;
- image digests, not mutable tags, select the runtime shipped to Users;
- viewer and host operations require expiring or rotation-capable authorization;
- teardown is idempotent and deletes only the intended VM and disk; and
- audit records tie every external Computer operation to its effect id.

Egress to private and control-plane ranges is denied by default. General Internet access passes through a controlled egress boundary that blocks infrastructure destinations and attaches credentials server-side.

---

## 9. Delivery phases

### Phase 1 — one proof host

On one disposable VX1 host:

1. verify `kvm_amd` loads and `/dev/kvm` is read/write — Vultr's "customer virtualization" statement is not an Incus certification;
2. install Incus reproducibly from repository-held definitions;
3. boot the real Chromium, Xvfb and noVNC image in an Incus VM;
4. measure idle resident memory, Chromium interaction latency, package and build I/O, two noisy Users at once, and memory reclaim; and
5. prove Tailscale-only administration and a Cloudflare Tunnel reaching a test gateway with no public origin port.

This picks the host size and the per-host admission cap.

### Phase 2 — live migration

Before buying a pool, live-migrate one running VM between two VX1 hosts using non-shared storage. Confirm the User's process, browser session, guest agent and viewer connection survive. Measure migration traffic, pause time and the spare headroom the destination needs. Exercise the Incus rebalancer with conservative thresholds and cooldowns.

### Phase 3 — host implementation

Build the client, gateway and guest agent, then pass the provider-neutral contract suite; real exec, Workspace, screenshot, browser and background-process operations; signed viewer creation, renewal and revocation; idempotent open and teardown; admission; and interrupted or retried operations under the same effect id.

### Phase 4 — pilot pool

Before admitting Users: complete the security checks in §8, a host-loss and R2 restore drill, 20 backup cycles without Chromium profile corruption, and alerts on host disk, memory pressure, restart loops, backup age, tunnel health and certificate expiry. Document rollback to Fly.

Grow to a pool of five hosts. Admit one User first and raise the cap one at a time as measured density stays stable.

### Phase 5 — terminal first

The credential boundary in §10 runs on the Sprite for every connected app. Carry it to the Incus host, route user-added MCP servers' APIs the same way, move their uses to CLIs, then delete `app/mcp/`.

---

## 10. Terminal first

An always-running Computer means a shell is there the moment a Bot wants one, with no cold start and no provisioning wait. That changes what the default way to act should be. Once the pilot pool is live, most of a Bot's work moves into its terminal: it runs command-line tools through `computer_exec` rather than calling bespoke tools the cloud has to host, list and proxy.

### What moves and what stays

- **MCP servers are replaced by CLIs.** A Bot reaches an outside service by installing and running its command-line tool — `gh`, `stripe`, `gcloud`, `aws`, a vendor's own CLI, or `curl` against a documented API — rather than through a remote MCP server added on the Connectors surface. When the CLI path covers what MCP servers do today, `app/mcp/` is deleted whole: the `mcp` Package and its Connection Type, sign-in, directory, tool namespace, routes and stored shapes, with the scoped cleanup of its records that a breaking stored-data change requires.
- **CLIs live on the Computer.** Common tools ship in the VM image; anything else a Bot installs goes under the designated persistent prefixes (§6), so it survives a rebuild. A Skill can teach a Bot a CLI the same way it teaches anything else.
- **The platform keeps what needs cloud authority.** The Agent loop still runs in the Bot Durable Object and treats the terminal as a tool. Conversation, memory, Approvals, Routines, cards, `send_to_user` and the audit stay native tools, because they are the cloud's own state.
- **Connected apps are decided app by app.** A Composio-connected app stays a tool until a CLI or plain HTTP path covers it through the credential boundary below. Connection triggers stay on the events door either way: an inbound event is not terminal work.

### Credentials never enter the VM

"Secrets stay server-side" still holds. A CLI runs with a placeholder token, never a real one. Every connected app answers on the Computer at `https://<app>.connected.internal/<path>`, the path resolved by the provider against that account's API base URL, and a few real hosts (`api.github.com` for `gh`) are routed as well. Requests to either go through a proxy on the Computer that terminates TLS for those names only, with a CA the Computer trusts, and forwards each request to the app Worker under a token that names the Turn's object and the exec call. The Bot Durable Object sends it as the connected account through the provider, which attaches the credential, so nothing on the Computer ever holds one. Every other destination is a plain tunnel. Revoking a Connection takes effect on the next request.

This runs on the Fly Sprite today (`computer/egress.ts`, `computer/fly/egress.ts`, `app/connect/egress.ts`, [architecture §10](architecture.md#connected-accounts-from-the-terminal)), for every app the person has connected, with no per-app table.

### Jev reviews every command

`computer_exec` is a `mutate` call, so Jev reviews every command before it runs, with the Turn's conversation: what a command reads and where it sends it are both the person's to have asked for, and that is also what stops a prompt-injected `curl` from carrying data out. Every request the command then makes as the person is reviewed again as a `credentialed_request` call before it is sent, because Jev saw `python sync.py`, not what the script reads or posts: a read once per API path for the command, so paging through a list is one review, and each write on its own. Jev's latency and price are negligible, so this is the default, not a cost to optimise.

### Effects

A command is one effect under its effect id: one whose outcome is unknown is reported as unknown, never re-run. Each credentialed request is its own effect under the command's id, sent at most once; a byte-identical write repeated inside the same command is answered with the first answer instead of sent again, so a CLI's retry does not repeat it.

### Long output

A foreground command returns at most 30 KB of stdout and stderr to the model, and runs for at most two minutes. Output the host cut short ends with a note saying so and telling the Bot to redirect long output to a file and read it with `head`, `tail` or `grep`; a job that outlasts the call runs with `background:true` and is read back through its bounded log. Credentialed responses are bounded at 8 MB on the way back to the CLI, which never counts against the model's context.

### Known gaps

- Only a foreground command gets connected accounts; a background process's token would outlive its review.
- The exec token sits in the command's environment, readable by another process of the same Linux user while the command runs. Binding it to the command's cgroup instead is the fix once the Computer runs a guest agent.
- `git` over HTTPS to `github.com` is not routed; only GitHub's API is.
- Bodies must be JSON objects: multipart uploads and streaming are not carried.
- Traffic to hosts without a connected account is not restricted; Jev's review of each command is the only guard on it.

### Open questions

- When each app's Composio tools can go, once the terminal has taken over its use.
- Whether a deny-by-default egress allowlist is worth adding under Jev's review.
- How a Bot discovers the CLIs available to it, beyond what the image lists and its Skills teach.

---

## 11. Non-goals for the first implementation

- automatic recovery of a failed host without a restore (shared storage and fencing);
- a distributed filesystem;
- Kubernetes or any other orchestrator above Incus;
- Incus authority over conversation or turn state; or
- removing Fly before rollback has been proven.

The implementing session may choose the Linux distribution, Incus version, instance-name format, backup tool (provided it produces encrypted provider-neutral generations in R2), observability stack and guest-agent transport. It stops for a new decision before changing one always-running VM per User, Incus as the VM manager, local NVMe with off-host backup, Cloudflare Tunnel for product ingress, Tailscale for operator access, or Durable Objects as the authority for accepted work.

---

## 12. Definition of done

1. A fresh host joins the pool from repository-held definitions without manual mutation.
2. The measured number of Computers stays resident per host under the declared envelope.
3. The Incus implementation passes the Computer host contract and real browser and viewer tests.
4. A planned move between hosts keeps processes and the viewer connected.
5. A lost host's Computers are restored elsewhere from R2 within the measured target.
6. A malicious VM test cannot reach another User, Incus, the host, cloud metadata or infrastructure credentials.
7. Cloudflare Tunnel is the only product ingress and Tailscale the only administrative ingress.
8. Capacity telemetry attributes live Computers and rejects admission past the cap.
9. Fly remains a tested rollback until an explicit later decision removes it.
