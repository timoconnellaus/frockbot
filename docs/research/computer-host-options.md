# FrockBot computer host — cited companion report

**Decision: run a small Cloudflare Containers versus GKE Agent Sandbox prototype before implementing a fixed Fly tariff. Cloudflare leads; Daytona remains the managed fallback.**

Companion to the standalone brief at [`computer-host-options.html`](./computer-host-options.html). This document exists to attach primary sources to that brief's claims and to separate three things the brief mixes by design:

> **Status — deferred 10 September 2026.** This report preserves the investigation and prototype recommendation. Cloudflare Containers and the other replacement hosts are outside the current billing implementation. FrockBot will finish the payment work against its existing product boundary and revisit Computer hosting separately.

- **[F]act** — stated in current first-party vendor documentation, with a link.
- **[D]esign inference** — a FrockBot architectural choice that follows from the facts but is not vendor-documented.
- **[U]nknown** — must be measured in the prototype; do not plan around it.

Sources checked 10 September 2026.

---

## 1. The decision

Fly Sprites gives FrockBot the Computer experience it wants today, and its per-hour rates are public and cheap to reason about — but Fly exposes per-Sprite cost only through the **Cost Explorer dashboard**, with no documented programmatic per-Sprite usage feed ([Fly community, Kyle](https://community.fly.io/t/tracking-cost-of-sprites/26822)). That blocks per-User prepaid billing, which is the launch blocker.

Cloudflare closes exactly that gap: `containersUsageAdaptiveGroups` returns billable usage **grouped by `instanceId`** — the same ID the dashboard shows ([Cloudflare GraphQL container metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)). If FrockBot pins one container instance per User, billing attribution is a query, not a reconstruction. Cloudflare is also already the platform: Workers, Durable Objects, R2 — so this removes a control plane rather than adding one.

The price of that is a **different persistence contract**, covered in §3. It is the one thing the prototype exists to de-risk.

**Kubernetes was assessed separately (§4) and changes the shortlist, but not the lead.** A normal StatefulSet/PVC deployment matches Cloudflare on compute cost and beats it on POSIX persistence, but carries a cluster floor, higher per-User idle storage, a slow billing export, and permanent cluster ownership. The newer **GKE Agent Sandbox** is more relevant: it is designed for isolated, stateful, single-replica agent workloads, and GKE Pod snapshots can capture memory and filesystem state. That may preserve the live Computer experience better than Cloudflare. The current snapshot workflow still needs recent GKE versions, Cloud Storage/IAM setup, and a temporary manual controller installation, so it belongs in the prototype rather than the launch architecture today.

**[D]** Daytona is the fallback rather than the first choice because it is semantically closer to Sprites (native pause with memory, first-party VNC) but roughly 2× the infrastructure cost of Cloudflare for the same shape, sits outside the Workers trust boundary, and settles billing up to 48 hours late.

---

## 2. Comparison

| Platform                        | Per-instance billable feed                                                                                                                                | Persistence after sleep                                                                                                                                                                       | Desktop / browser                                                                                             | Network control                                                                                          | Cost for a 1 vCPU / 6 GiB / 12 GB desktop, awake, 25% CPU                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Cloudflare Containers**       | **Strong.** GraphQL by `instanceId`: `cpuTimeSec`, `allocatedMemory`, `allocatedDisk`, `txBytes` (sum only)                                               | **Checkpointed.** All local disk is ephemeral; Sandbox backup → R2 → restore as copy-on-write overlay. No process state                                                                       | **Build it.** Full container + port exposure; carry the existing Chromium/Xvfb/noVNC stack                    | **Strong.** Deny-by-default `allowedHosts`, HTTPS interception on by default, secrets held in the Worker | **≈ $0.075/h** (`standard-2`)                                                                                      |
| **Daytona**                     | **Strong shape.** Per-sandbox CPU-s / RAM GB-s / disk GB-s with sandbox ID; **up to 48 h settlement lag**                                                 | **Strong.** Stopped keeps disk; VM pause keeps RAM; archive keeps full state at no compute/disk charge                                                                                        | **Native.** First-party Computer Use: Xvfb + XFCE4 + x11vnc + noVNC, mouse/keyboard/screenshot/recording APIs | **Strong.** Domain/CIDR allowlists and outbound proxy                                                    | **≈ $0.148/h** (billed on _reserved_, not actual)                                                                  |
| **Fly Sprites**                 | **Blocked.** Cost Explorer dashboard only; no documented per-Sprite usage API                                                                             | **Excellent.** Native persistent computer; running/warm/cold states, only running is billed                                                                                                   | **Proven.** FrockBot's current implementation                                                                 | **Implemented.** Existing host proxy + allowlist                                                         | **≈ $0.288/h**                                                                                                     |
| **E2B**                         | **Partial.** Sandbox metrics exist; no canonical billable-usage feed in public docs                                                                       | **Partial.** Hobby caps a session at 1 h, Pro at 24 h; multi-day is Enterprise                                                                                                                | **Build it.** No first-party desktop surface                                                                  | **Basic.** Internet can be disabled                                                                      | vCPU $0.000014/s + RAM $0.0000045/GiB-s, **on top of a $150/mo Pro base**                                          |
| **Modal Sandboxes**             | **Workable.** Billing reports + tags, but cost is `max(requested, actual)`                                                                                | **Checkpointed.** Filesystem snapshots GA (30-day default TTL); **memory snapshots are alpha, hard 7-day expiry**                                                                             | **Build it.** Sandboxes + tunnels, no first-party desktop                                                     | **Available.** Proxies; region pinning adds a multiplier                                                 | Sandbox rates are the most expensive of the set                                                                    |
| **Vercel Sandbox**              | **Insufficiently granular.** Usage dashboard is team/project-oriented; tags are beta                                                                      | **Good, but session-bounded.** Persistence is the default (auto-save on stop, resume on start); 24 h _session_ cap resets on stop/resume so lifetime is unbounded. No live-process continuity | **Ecosystem.** No first-party desktop                                                                         | **Reasonable.** Egress firewall available                                                                | Active CPU $0.128/h + memory $0.0212/GB-h (`iad1`)                                                                 |
| **GKE Agent Sandbox**           | **Workable.** Autopilot runtime is deterministic from Pod requests; allocate by User-labelled lifecycle records and reconcile against GKE cost allocation | **Potentially excellent.** Persistent volumes are native; whole-Pod snapshots can capture memory and filesystem state. Snapshot integration is still maturing                                 | **Build it.** Stable single-Pod identity and routing; carry the Chromium/noVNC image                          | **Strong.** gVisor plus default-deny sandbox networking and namespaced identity                          | **≈ $0.075/h while scheduled**, plus snapshot/storage and shared cluster costs                                     |
| **GKE Autopilot** (per-pod K8s) | **Workable but slow.** Cost allocation labels every pod in the BigQuery billing export; **request-based, up to 3-day latency**, not retroactive           | **Strong.** StatefulSet + per-replica PVC survives pod deletion and scale-to-zero; disk billed 24×7                                                                                           | **Build it.** Any image; you own the desktop stack entirely                                                   | **Strong but self-owned.** NetworkPolicy / Dataplane V2 + egress gateway, all configured by you          | **≈ $0.075/h while the pod is scheduled** (bills *requests*, not activity) **+ $1.20/mo PVC + $73/mo cluster fee** |
| **Fixed-node managed cluster**  | **Same feed, worse economics.** Cost allocation still works, but node cost is incurred whether or not pods run                                            | **Strong.** Same PVC model, plus local NVMe if you pick the node shape                                                                                                                        | **Build it.** Same as above                                                                                   | **Strong but self-owned.** Same as above                                                                 | Node cost runs **24×7 regardless of user activity**; per-User cost = node rate ÷ packing density (see §4.4)        |

Cost column is arithmetic from published rates for the same workload shape, excluding egress, storage, and control-plane services. Cloudflare's included Workers Paid allowances are deliberately ignored so the customer-facing rate stays stable.

### Rate arithmetic, checked

Cloudflare publishes per-second rates; the brief's calculator uses per-hour. They agree:

|        | Published               | × 3600                  |
| ------ | ----------------------- | ----------------------- |
| CPU    | $0.000020 / vCPU-second | **$0.072 / vCPU-hour**  |
| Memory | $0.0000025 / GiB-second | **$0.009 / GiB-hour**   |
| Disk   | $0.00000007 / GB-second | **$0.000252 / GB-hour** |

`standard-2` = 1 vCPU / 6 GiB / 12 GB. At 25% CPU: `0.072×0.25 + 6×0.009 + 12×0.000252 = $0.0750/h`. **[F]** Containers bill "for every 10ms that they are actively running"; CPU is charged on actual use, memory and disk on provisioned amount for the running duration; sleeping instances incur no compute charge ([pricing](https://developers.cloudflare.com/containers/platform/pricing/)).

The smallest Cloudflare instance type is `lite` (1/16 vCPU, 256 MiB, 2 GB). Full ladder: `lite`, `basic` (¼, 1 GiB, 4 GB), `standard-1` (½, 4 GiB, 8 GB), `standard-2` (1, 6 GiB, 12 GB), `standard-3` (2, 8 GiB, 16 GB), `standard-4` (4, 12 GiB, 20 GB).

Vercel's docs describe persistence as the default Sandbox behaviour; **Drives** are the beta feature. The conclusion (no advantage over Cloudflare for this stack) is unaffected.

---

## 3. The Cloudflare persistence question, in full

This is the user's observation, and it holds up against the docs. Three separate mechanisms are involved and they are easy to conflate.

### 3.1 Local disk is ephemeral — [F]

> "All disk is ephemeral. When a Container instance goes to sleep, the next time it is started, it will have a fresh disk as defined by its container image."
> — [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/)

Each instance is independent. Nothing survives a sleep unless it was explicitly written elsewhere. Shutdown is `SIGTERM`, up to 15 minutes to exit, then `SIGKILL`; `onActivityExpired()` fires after an inactivity timeout that defaults to 10 minutes.

### 3.2 Direct R2 FUSE is not a POSIX/SSD substitute — [F]

The same page offers FUSE-mounting R2 or other object storage as the way to keep data between restarts, while stating performance will not match native SSD. Object storage semantics are the deeper problem, not just throughput: no POSIX locking, no atomic rename guarantees, no `fsync` contract.

**[D]** A live R2 FUSE mount is appropriate for ordinary workspace files the user reads and writes deliberately. It is **not** appropriate for a Chromium profile directory, which is a set of SQLite databases (`Cookies`, `History`, `Login Data`, `Local Storage/leveldb`) that assume POSIX locking and durable ordering. Pointing Chromium's `--user-data-dir` at a FUSE-mounted bucket is the failure mode to avoid.

### 3.3 The Sandbox backup API is the right mechanism — [F]

[Sandbox backups](https://developers.cloudflare.com/sandbox/api/backups/):

- **Targets:** `/workspace`, `/home`, `/tmp`, `/var/tmp`, `/app` — so `/home` (the browser profile) and `/workspace` (user files) are both directly supported.
- **Storage:** written to R2 as `backups/{id}/data.sqsh` + `backups/{id}/meta.json` — a squashfs image, created with `mksquashfs`.
- **Restore:** in production, "the backup is a read-only lower layer and new writes go to a writable upper layer" — a copy-on-write overlay. In local dev, the directory is replaced outright.
- **The overlay is itself ephemeral:** "the FUSE mount is lost when the sandbox sleeps or restarts." **Restore is not once-and-done — it must be re-issued on every wake, from the stored handle.**
- **TTL:** default `259200` seconds (3 days), and critically "`ttl` is enforced at restore time only. Expired objects remain in R2" until deleted manually or by a lifecycle rule.
- **`mksquashfs` must read every file and subdirectory**; restrictive permissions cause failures.

### 3.4 Why Chromium must be quiesced first — [F] + [D]

**[F]** The backup docs state plainly: "Partially written files may not be captured consistently. Completed writes are included." They also direct you to stop processes writing to the target directories.

**[D]** A running Chromium is continuously mid-write to its profile SQLite files and its LevelDB store. Snapshotting underneath it captures a torn image: a database with an unapplied WAL, a `SingletonLock` naming a PID that will not exist on the next instance, LevelDB `.log` files with a partial record at the tail. Restoring that yields the failure class that is most expensive for FrockBot — not a crash, but a _silently degraded profile_: dropped cookies, a lost session, "you've been signed out." Browser identity is the thing the Computer exists to hold.

The safe sequence:

1. Stop accepting new turns for this User.
2. Signal Chromium to exit cleanly and wait for the process to exit (do not `SIGKILL`).
3. Verify the profile lock files are gone.
4. Create the backup of `/home` (and `/workspace`).
5. Persist the backup handle durably — in the Bot Durable Object, not on the container.
6. Let the container sleep.

On wake: restore from the stored handle, **then** start Chromium.

### 3.5 Process state does not survive — [F]

Cloudflare's backup mechanism is a filesystem archive. There is no memory or process snapshot in the Containers/Sandbox product. A new instance starts from the image, gets a restored overlay of directories, and starts fresh processes. Anything that was in RAM — an open tab's JS heap, an in-flight upload, a half-typed form, a `ssh` session, a background daemon's accumulated state — is gone.

This is the concrete difference from Fly Sprites (which advertises full environment checkpoint and restore) and from Daytona VM pause (which snapshots RAM). Modal also offers memory snapshots, but they are alpha with a hard 7-day expiry. GKE Pod snapshots can capture a sandbox Pod's memory and filesystem, which is why Agent Sandbox is now the strongest Kubernetes challenger.

**[D]** FrockBot can absorb this because a turn's intent lives in the Bot Durable Object, not in the container. Recovery is: restore files → restart Chromium → replay from durable turn intent. What FrockBot cannot offer under this design is "your session is exactly where you left it, mid-scroll."

**[U]** Whether users perceive that gap as a defect. If they do, the answer is Daytona VM pause or staying on Sprites — not a Cloudflare workaround.

---

## 4. Kubernetes as an architecture

Assessed after the initial review, on the question: should FrockBot run one persistent browser desktop per User as a Kubernetes Pod? Three shapes were considered: **GKE Agent Sandbox**, **managed per-Pod Kubernetes** (GKE Autopilot, billed on Pod requests), and a **fixed-node managed cluster** (GKE Standard or equivalent, billed on nodes).

**Verdict: GKE Agent Sandbox earns a prototype slot, while generic Kubernetes does not.** Cloudflare keeps the lead because its per-instance billing feed and existing control plane are much simpler. Agent Sandbox may offer better session continuity and should be measured before FrockBot commits to Cloudflare's file-only recovery model.

### 4.1 GKE Agent Sandbox — [F] + [U]

Google describes [GKE Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox) as a system for "isolated, stateful, and single-replica workloads" such as AI agent runtimes and development environments. Its `Sandbox` resource provides stable network identity and persistent storage; its router gives each Sandbox a stable endpoint; gVisor provides isolation; and its network posture denies access to internal networks and the GKE control plane by default. Warm pools can allocate pre-created environments in under one second, although keeping them warm has an idle cost.

[GKE Pod snapshots](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox-pod-snapshots) can capture "the state of the Pod's memory and its file system" to Cloud Storage and restore a Sandbox from the latest matching snapshot. This directly targets the live-state gap in Cloudflare's directory backup approach. It might preserve open browser tabs and in-memory processes across suspension, subject to a successful Chromium/noVNC test.

The maturity caveat is material. Full support requires GKE 1.35.3-gke.1234000 or later. Google's current tutorial says the snapshot suspend/resume workflow temporarily requires manual installation of the open-source Agent Sandbox controller until those features are fully available in the managed add-on. It also requires Pod-snapshot resources, a Cloud Storage bucket, managed folders, Workload Identity and IAM bindings. **[U]** Snapshot/restore latency, Chromium compatibility, retained socket behavior, snapshot size and storage cost must all be measured.

**[D]** This is a better Kubernetes prototype than a hand-built StatefulSet because it supplies the lifecycle and routing abstractions FrockBot would otherwise own. It still adds a second cloud and a Kubernetes control plane. That is why it challenges Cloudflare on Computer fidelity without displacing it on launch simplicity.

### 4.2 Scale-to-zero and idle billing — [F]

Autopilot genuinely scales to zero: "If a cluster has no running workloads, Autopilot can automatically scale the cluster down to zero nodes" ([Autopilot overview](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview)). Pod-based billing charges "in one-second increments for the CPU, memory, and ephemeral storage resources that your running Pods **request**" with no minimum duration, and you are not charged for system DaemonSets, OS overhead, unallocated space, or unscheduled pods ([GKE pricing](https://cloud.google.com/kubernetes-engine/pricing)).

Two costs do **not** go to zero:

- **The cluster fee.** "$0.10 per cluster per hour" applies to every GKE cluster regardless of mode, size or topology — **$73/month floor**, before a single User exists. The GKE free tier gives $74.40/month in credits covering one Autopilot or zonal cluster, which masks this at prototype scale and stops masking it the moment you want a second cluster or a regional one.
- **The PVC.** Persistent disks are billed on provisioned capacity for as long as they exist. A 12 GiB `pd-balanced` volume at $0.000136986/GiB-hour is **$1.20/month per User, billed 24×7**, whether that User opens their Computer or not.

**[D]** That second item is the structural mismatch. FrockBot's economics assume a mostly-idle Computer. Cloudflare's equivalent — a squashfs backup in R2 at ~$0.015/GB-month — is roughly **$0.18/month** for the same 12 GB. Per-User idle storage is ~6.7× more expensive on GKE, and it is the cost that scales with signups rather than with usage.

### 4.3 Generic StatefulSet persistence — [F], and it is genuinely good

This is Kubernetes' strongest showing. PVCs are independent of pods: "The disk and data represented by a PersistentVolume continue to exist as the cluster changes and as Pods are deleted and recreated" ([GKE persistent volumes](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/persistent-volumes)). StatefulSets are "the recommended method of deploying stateful applications that require a unique volume per replica" via `volumeClaimTemplates` — so `frockbot-user-<id>` maps cleanly to a stable pod identity with a stable disk.

Critically, this is a **real POSIX block device**, not object storage. It solves §3's entire problem class outright: Chromium's profile SQLite and LevelDB files live on a normal filesystem with normal locking, no quiesce-before-backup dance, no torn-snapshot risk, no re-restore on every wake.

**[F]** Caveats: persistent disks are zonal, and "Pods referencing the disk are scheduled to the same zone as the persistent disk" — so each User is pinned to a zone, and a zonal outage takes their Computer offline until you resolve it. `reclaimPolicy: Retain` is required if you want account deletion to be a deliberate act rather than a side effect of deleting a PVC.

**[D]** In the generic StatefulSet/PVC design, process/RAM state still does not survive. A Pod restart is a fresh process tree. GKE Agent Sandbox with whole-Pod snapshots is the distinct exception described in §4.1.

### 4.4 Per-Pod attribution — [F], workable, but the slowest feed assessed

GKE cost allocation writes per-workload cost into the **Cloud Billing detailed usage export to BigQuery**, labelled with `k8s-namespace`, `k8s-workload-name`, `k8s-workload-type`, and up to 50 custom pod labels as `k8s-label/${key}` ([cost allocation](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/cost-allocations)). A `frockbot-user-id` pod label would flow straight through. The shape is right.

The problems are latency and semantics:

- **"It can take up to three days for data to appear in Cloud Billing."** That is worse than Daytona's 48 hours and far worse than Cloudflare's GraphQL feed (whose freshness is undocumented — [U] — but which is a live analytics dataset, not a batch billing export).
- **"GKE cost allocation data is based on resource requests, not resources consumed."** For prepaid billing this is arguably a _feature_ — the charge is deterministic and knowable at scheduling time, so FrockBot could bill without waiting for the feed at all. But it means a User who sits idle with a scheduled pod is charged the full request. There is no equivalent of Cloudflare's "CPU billed only while active."
- **Not retroactive**, so it must be enabled before any real usage.

**[D]** Because billing is request-based, FrockBot on Autopilot would compute the charge itself from pod uptime × known request size, and use BigQuery only for reconciliation. That is a perfectly sound design — it just means the vendor feed is an audit trail, not the meter.

### 4.5 Normalized cost

Using the same workload as §2 — one desktop, 1 vCPU / 6 GiB, awake 20 h/month — at official `us-central1` Autopilot rates ($0.0445/vCPU-h, $0.0049225/GiB-h, $0.0001389/GiB-h ephemeral SSD, all confirmed on the [GKE pricing page](https://cloud.google.com/kubernetes-engine/pricing)):

```
While scheduled: 0.0445 + (6 × 0.0049225) + (10 × 0.0001389) = $0.0754/h
```

|                           | Cloudflare Containers           | GKE Autopilot              |
| ------------------------- | ------------------------------- | -------------------------- |
| Compute, 20 awake h/month | $1.50                           | $1.51                      |
| Per-User idle storage     | ~$0.18 (12 GB in R2)            | $1.20 (12 GiB pd-balanced) |
| **Per-User total**        | **~$1.68**                      | **~$2.71**                 |
| Fixed platform floor      | $0 above existing Workers spend | **$73/month** cluster fee  |

The compute lines are near-identical — a genuinely surprising result, and worth stating plainly: **Autopilot is not expensive compute.** The gap is entirely idle storage and the cluster floor.

**[F]** Two shape constraints worth knowing: Autopilot's general-purpose CPU:memory ratio must be between 1:1 and 1:6.5, so 1 vCPU : 6 GiB is legal with little headroom; and ephemeral storage for general-purpose pods without local SSD "must be between 10 MiB and 10 GiB" ([resource requests](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)). A 12 GB desktop disk therefore **cannot** be ephemeral storage — it must be a PVC or generic ephemeral volume, which is what makes the $1.20/month unavoidable rather than an implementation choice.

**Fixed-node cluster.** The arithmetic inverts. Per-User cost becomes `node hourly rate ÷ pods per node × 730`, paid whether or not anyone is awake. To beat Autopilot you need high packing density and high utilization simultaneously — but a browser desktop needs ~6 GiB resident to be usable, so a node packs few of them, and FrockBot's usage is bursty and uncorrelated across Users. **[D]** This is the worst fit of every option assessed: it takes FrockBot's variable-cost, mostly-idle workload and puts it on a fixed-cost substrate, meaning margin depends on capacity forecasting. It is only rational at a scale where aggregate demand is smooth and predictable — which is not launch. **[U]** The specific node SKU rate was not verified against a first-party source in this review (Google's Compute Engine pricing tables are JavaScript-rendered and did not yield a quotable figure), so no per-node number is asserted here.

### 4.6 Isolation for untrusted browser sessions — [F], adequate

GKE Sandbox uses gVisor, "a userspace re-implementation of the Linux kernel API," giving each sandboxed pod its own kernel to "prevent untrusted code from affecting the host kernel," explicitly aimed at multi-tenant clusters and SaaS running user-submitted code ([GKE Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods)). It is available on Autopilot with no cluster configuration — "ready to use in Autopilot clusters running GKE version 1.27.4-gke.800 and later," activated by setting `runtimeClassName: gvisor` ([how-to](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods)).

**[F]** The documented trade-off: "imposing an additional layer of indirection for accessing the node's kernel comes with performance trade-offs," particularly for applications generating numerous small I/O operations, and "workloads with high volume of syscalls may need more resources."

**[D]** Chromium is precisely such a workload — heavy syscall traffic, many small reads and writes against the profile, plus its own multi-process sandbox layered on top of gVisor's. **[U]** Whether a gVisor-sandboxed Chromium desktop is acceptably responsive over noVNC is untested here and would need measurement before this path could be taken seriously.

Note this is still a step _below_ the alternatives on isolation strength: Cloudflare Sandbox and Vercel give each tenant a **separate VM/microVM**; gVisor is a shared-kernel-host with a userspace kernel per pod. Strong, but a different threat model.

### 4.7 Cold starts — [U], with one documented mitigation

No first-party latency figure exists for scale-from-zero. The Autopilot docs say only that "the first workloads that you deploy take more time to schedule" on a cluster starting from zero nodes, and describe "fast scaling times" without numbers.

**[F]** The one quantified data point is image pull: GKE Image streaming serves image data on demand rather than pulling the whole image first, and the docs cite a 327 MB image deploying in **1.5 seconds versus 24 seconds** without it. Autopilot enables it automatically ([image streaming](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming)). That materially helps a multi-GB Chromium desktop image — with the caveat that "workloads reading many files during initialization may experience increased latency," and a desktop boot reads many files.

**[D]** Image pull is not the dominant term anyway. Scale-from-zero requires _node provisioning_ — a VM boot — before any pod schedules. That is a minutes-scale operation, versus Cloudflare's container wake. Keeping warm nodes to hide it reintroduces exactly the idle cost that scale-to-zero was supposed to remove.

### 4.8 Operational burden — the decisive factor

Everything above is a tractable engineering problem. This is the one that settles it.

**[D]** The Cloudflare path adds a binding to a Worker FrockBot already runs. The Kubernetes path makes FrockBot the operator of a cluster: node pool and control-plane upgrade cycles, a `gvisor` RuntimeClass, per-User PVC lifecycle and orphan reclamation, zonal pinning and the failover story it implies, NetworkPolicy authoring to replace the deny-by-default egress FrockBot gets declaratively from Cloudflare Sandbox, a BigQuery billing pipeline, IAM, and a second cloud account in the security perimeter. Cloudflare's outbound handlers keep credentials in the Worker so "no token is exposed to the sandbox"; reproducing that on Kubernetes means building an egress proxy and keeping it correct.

None of this is exotic. All of it is permanent, and none of it is FrockBot's product.

### 4.9 When this conclusion should be revisited — [D]

Kubernetes becomes the right answer if any of these turn true:

1. **The §3 prototype fails** — i.e. the quiesce/backup/restore cycle cannot preserve browser identity reliably. Test Agent Sandbox whole-Pod snapshots first; use a real POSIX PVC if live-state snapshots do not prove reliable.
2. **Per-User idle count stays low while awake-hours per User go high.** The GKE penalty is idle storage and a fixed floor; heavy, sustained usage amortizes both.
3. **FrockBot needs hardware Cloudflare does not offer** — GPUs for local inference, or instance shapes above `standard-4`.
4. **An operations team exists.** The burden in §4.7 is decisive for a small team and merely ordinary for a platform team.

---

## 5. Recovered ZeroBSAI prior art

The Cloudflare design is not only a paper architecture. ZeroBSAI implemented most of the difficult storage split before its product app was removed in commit `fea4c259` (25 August 2026). The useful history begins with the Cloudflare sandbox setup in `4b617cc1`, adds the command-running prototype in `ce465d6a`, the R2/restic cache design in `b4cfbb5a`, R2 event/version synchronization in `576c98fe`, and local FUSE support in `eb342cab`.

### 5.1 Container and workspace — [F] + [D]

ZeroBSAI used one Durable Object and Cloudflare Container identity per User. At startup, `tigrisfs` mounted a per-User R2 prefix at `/workspace`. This made ordinary source files and documents continuously durable while the container remained disposable. Local Wrangler development could not normally expose `/dev/fuse`, so `scripts/docker-fuse-proxy.mjs` patched Docker container creation to add `SYS_ADMIN` and `/dev/fuse`.

The implementation deliberately kept high-churn state off FUSE. Source files were copied to local `/projects`; `node_modules`, `.astro`, `dist` and the Bun cache lived on local POSIX disk. Restic stored recoverable snapshots of that local cache in R2. This confirms the core design rule for FrockBot: direct R2 FUSE can hold ordinary workspace files, while Chromium profiles, SQLite/LevelDB stores, package trees and build caches need local POSIX semantics.

### 5.2 The remembered C code — [F] + security review required

The C implementation lives in the related `crabby-kit` repository, while a polling shell predecessor survives in ZeroBSAI's stash:

- `packages/infra/sandbox-cloudflare/container/nm-intercept.c` is an `LD_PRELOAD` library that intercepts libc `mkdir` and `mkdirat`. When a top-level `node_modules` is created under `/workspace`, it invokes the mount helper synchronously, before the package manager's first write can reach R2.
- `nm-mount-helper.c` validates the target, hashes its relative path into a local `/opt/sandbox/nm/<hash>` directory, creates that directory and bind-mounts it over the FUSE path.
- This closes the race in the polling version and avoids two real object-filesystem failures: execute bits not being preserved and parallel package writes failing against FUSE.

**[D] Do not copy this helper unchanged.** It is setuid root and accepts mount roots from environment variables. A production version needs fixed roots, component-aware path validation, file-descriptor-based resolution such as `openat2`, sanitized environment, protection against symlink races and the smallest possible capability set. The mechanism solves one package-directory problem; it does not make R2 POSIX-safe or suitable for a live Chromium profile.

### 5.3 Recovery and credential separation — [D]

The strongest recovered design is `crabby-kit`'s root-owned restic synchronization daemon. It holds the R2 credentials and restic password, serializes backup/restore/prune operations, and exposes a narrow Unix socket to the sandbox user. That is safer than placing R2 credentials in the ordinary user process.

Cloudflare's current Sandbox backup API should now be the default for quiesced `/home` and `/workspace` snapshots because it is maintained by the platform and restores a copy-on-write layer. Restic remains useful when FrockBot needs selective, encrypted or incremental snapshots of high-churn cache state. In either case, Chromium must exit cleanly before its local profile is captured.

### 5.4 Memory is a separate durable plane — [F] + [D]

ZeroBSAI did not keep agent memory in the Computer filesystem:

- R2 held canonical, human-readable Markdown plus per-file chunk metadata.
- Vectorize held replaceable 768-dimensional embeddings using `@cf/baai/bge-base-en-v1.5`.
- Re-indexing embedded only changed chunks, deleted stale vector IDs and then committed the new metadata.
- Retrieval queried Vectorize, deduplicated by file, and read the canonical Markdown back from R2 for the actual snippet. A keyword scan of R2 was the fallback when embeddings or Vectorize failed.
- Pinned preference files were always included; the top semantic matches for the latest User message were added before each turn.

This is the right boundary for FrockBot. The Bot Durable Object owns turns and control state; R2 owns durable memory text; Vectorize is a rebuildable retrieval index; the Computer filesystem owns working files and a restartable browser environment. Memory must remain usable even when the Computer is asleep, corrupt or being replaced.

### 5.5 Effect on the recommendation — [D]

The recovered implementation increases confidence in Cloudflare as the lead prototype. Reuse the per-User Durable Object/container mapping, the R2 workspace for ordinary files, local-disk carve-outs, quiesced checkpointing, and R2-plus-Vectorize memory. Redesign credential delivery and the privileged mount helper, and use Cloudflare's current backup API where it supersedes bespoke restic behavior.

---

## 6. Open items for the prototype — [U]

1. **Cold-wake latency.** Restore `/home` + boot Xvfb/Chromium/noVNC on `standard-1` and `standard-2`. Measure to first interactive frame. No vendor number exists for this.
2. **Profile fidelity after a restore cycle.** Quiesce → back up → sleep → wake → restore → confirm cookies, logged-in sessions, extensions and user files all survive. Repeat 20+ cycles; profile corruption is often cumulative, not first-cycle.
3. **Billing feed freshness.** The GraphQL dataset has the right dimensions and units, but **the docs make no latency or freshness promise**. Measure how long after a container sleeps its usage appears, and whether the total reconciles against the dashboard.
4. **Crash-loss window.** If the container dies without a clean quiesce, how much is lost? Periodic checkpoints bound this; the prototype must produce the number FrockBot will state to users.
5. **Hybrid filesystem behavior.** Run ordinary workspace files directly on tigrisfs while Chromium and package state use local disk. Verify cross-layer moves, permissions, deletion, concurrent access and cold recovery. The prototype must show that the split remains understandable and deterministic under failure.
6. **Memory independence.** Prove that R2-backed Markdown memory and its Vectorize index remain available while the Computer is asleep, and that the index can be rebuilt from R2 without losing meaning or provenance.
7. **Retention for inactive accounts.** The backup TTL defaults to **3 days** and is only checked at restore. A User who returns after a week finds an expired handle. FrockBot must set a long explicit TTL, own R2 lifecycle rules directly, and define an account-deletion path — this is a design requirement, not a prototype question, and the 3-day default makes it urgent.

---

## 7. Primary sources

**Cloudflare**

- [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) — per-second rates, instance ladder, 10 ms billing, included allowances, egress
- [Container lifecycle & architecture](https://developers.cloudflare.com/containers/concepts/architecture/) — ephemeral disk, SIGTERM/15 min/SIGKILL, lifecycle hooks
- [Mount an R2 bucket with FUSE](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/) — supported tigrisfs setup and required FUSE capability
- [Querying container metrics via GraphQL](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/) — `containersUsageAdaptiveGroups`, `instanceId`, `cpuTimeSec`, `allocatedMemory`, `allocatedDisk`, `txBytes`
- [Sandbox backup API](https://developers.cloudflare.com/sandbox/api/backups/) — targets, squashfs in R2, CoW restore, ephemeral mount, 3-day TTL, consistency warnings
- [Sandbox security](https://developers.cloudflare.com/sandbox/concepts/security/) — per-sandbox VM isolation
- [Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) — `enableInternet`, `allowedHosts`/`deniedHosts`, `interceptHttps`, secrets held in the Worker

**Daytona**

- [Billing](https://www.daytona.io/docs/en/billing/) — per-sandbox CPU-s/RAM GB-s/disk GB-s, 48 h settlement lag, charges by state
- [Sandboxes / lifecycle](https://www.daytona.io/docs/sandboxes) — started/stopped/paused/archived, VM vs container classes, auto-stop/pause/archive/delete
- [Computer Use](https://www.daytona.io/docs/computer-use/) — Xvfb + XFCE4 + x11vnc + noVNC, input/screenshot/recording APIs
- [Pricing](https://www.daytona.io/pricing) — $0.0504/vCPU-h, $0.0162/GiB RAM-h, $0.000108/GiB disk-h after 5 GiB free, per-second billing

**Fly**

- [Sprites](https://fly.io/sprites/) — persistent Linux computers for agents, checkpoint/restore
- [Pricing](https://fly.io/pricing/) — $0.07/CPU-h, $0.04375/GB-h, hot $0.000683/GB-h, cold $0.000027/GB-h, nothing charged per Sprite
- [Tracking cost of sprites](https://community.fly.io/t/tracking-cost-of-sprites/26822) — Cost Explorer dashboard is the stated method

**Others**

- [E2B pricing](https://e2b.dev/pricing) — $150/mo Pro, $0.000014/vCPU-s, $0.0000045/GiB-s, 1 h Hobby / 24 h Pro session caps
- [Modal sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots) — filesystem snapshots GA (30-day TTL), memory snapshots alpha (7-day, terminates on snapshot)
- [Modal sandbox resources](https://modal.com/docs/guide/sandbox-resources) — `max(requested, actual)` billing
- [Vercel Sandbox](https://vercel.com/docs/sandbox) and [pricing](https://vercel.com/docs/sandbox/pricing) — $0.128/h Active CPU, $0.0212/GB-h memory (`iad1`), 24 h session cap, persistence by default, Drives in beta

**Kubernetes (Google Cloud)**

- [GKE Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox) — stateful single-Pod sandboxes, stable routing, warm pools, default-deny networking and gVisor isolation
- [Agent Sandbox Pod snapshots](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox-pod-snapshots) — memory/filesystem capture, Cloud Storage restore, version and current manual-controller requirements
- [GKE pricing](https://cloud.google.com/kubernetes-engine/pricing) — $0.10/cluster-hour fee, pod-based billing on requests in 1-second increments, $0.0445/vCPU-h, $0.0049225/GiB-h, $0.0001389/GiB-h ephemeral SSD, $74.40/mo free-tier credit
- [Autopilot overview](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview) — pod-based vs node-based billing, scale to zero nodes, hardened defaults, Dataplane V2
- [Resource requests in Autopilot](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests) — 1:1–1:6.5 CPU:memory ratio, 10 MiB–10 GiB ephemeral storage cap, min/max requests
- [GKE cost allocation](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/cost-allocations) — per-namespace/workload/pod-label attribution into the BigQuery detailed billing export, request-based, up to 3-day latency, not retroactive
- [Persistent volumes in GKE](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/persistent-volumes) — PV/PVC independence from pods, StatefulSet per-replica volumes, reclaim policies, zonal binding
- [GKE Sandbox concepts](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods) and [how-to](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/sandbox-pods) — gVisor per-pod kernel, Autopilot support from 1.27.4-gke.800 via `runtimeClassName: gvisor`, syscall-overhead caveat
- [GKE Image streaming](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/image-streaming) — on by default in Autopilot; 327 MB image in 1.5 s vs 24 s
- [Persistent Disk pricing](https://cloud.google.com/compute/disks-image-pricing) — pd-balanced provisioned space $0.000136986/GiB-hour
