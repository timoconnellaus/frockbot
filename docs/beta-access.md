# Beta access

Signing in proves who someone is. It does not give them FrockBot. Access is decided by one authority, the singleton `DeploymentPolicy` Durable Object (`apps/cloudflare/src/deployment-policy.ts`), and the rule it applies is `evaluateAdmissionV1` (`apps/cloudflare/src/account-admission.ts`).

This is the hosted deployment's rule, and it holds wherever the built [auth Package](architecture.md#12-auth) answers `admission: "authority"`. A deployment that builds Cloudflare Access has no authority to ask: its Access policy is the allowlist, so the seam in `index.ts` admits every identity the Package produced and none of what follows applies ([ADR 0028](adr/0028-open-deployment.md)).

## The rule

The deployment has one **admission mode**:

- `closed`: no new accounts. The default.
- `invite-only`: invited accounts become active on their next authenticated request.
- `open`: any account without a record becomes active on its next authenticated request.

Each account may have an **access record** keyed by its User id, in one of five states: `invited`, `active`, `paused`, `ended` or `blocked`.

The authority applies these checks in order:

1. A deployment admin (`FROCKBOT_ADMIN_EMAILS`) is admitted. No record is read or written. The Worker answers for an admin without calling the authority, so admins still get in while it is down.
2. An account with a record is decided by that record. `active` is admitted. `paused`, `ended` and `blocked` are refused in every mode, including `open`. `invited` becomes `active` unless the mode is `closed`.
3. An account with no record is admitted if an email invitation matches its **verified** email. The invitation is spent in the same transaction, unless the mode is `closed`, which keeps it for later.
4. Otherwise the mode decides. `open` activates the account. `invite-only` refuses it as `invitation-required`, and `closed` refuses it as `admission-closed`.

Admission itself only ever writes `active` over no record or over `invited`. It never lifts a pause, end or block. Every account admission decision and write happens inside one synchronous storage transaction in the one object, so a sign-in and an admin change cannot interleave. Admin mode and account writes are compare-and-swap on the record's revision, and admission advances that revision too. An admin who acts on a stale read gets a `409`; nothing is silently overwritten.

A provisioned User, an existing better-auth identity or a live session are not access. An account with none of the above is refused however long it has existed.

## Where it is asked

- **Identity creation.** better-auth's `user.create.before` hook (`identityCreationHooksV1`, `app/auth/better-auth/index.ts`) asks `mayCreateIdentity`. Admins may create an identity in every mode. For everyone else, a closed deployment writes no `user` row; an invite-only deployment writes one only for an invited, verified address.
- **Authenticated browser requests.** The gateway asks `admitAccount` after resolving the session and before anything reaches a User Durable Object. A pause takes effect on the account's next request.
- **Authenticated native requests.** `nativeAuth.authenticate` first verifies the bearer and reads its existing durable session without provisioning a User, then asks the authority. Missing or revoked sessions cannot activate access or spend an invitation. The exchange checks issuance eligibility without provisioning, then asks before issuing a session, and the settings handoff asks through `authenticate`. Sign-out verifies the bearer and revokes its existing session even when access is refused or the admission authority is unavailable. Session reads and revocations never provision a User. The gateway reuses the native answer rather than asking twice.
- **Signed public requests.** Routine webhook deliveries and machine enrollments verify their token, then use the authority's read-only `checkAccount` through the stored identity before User or Bot access. These checks apply the same rule without activating an account or spending an invitation. Existing admitted work is not cancelled; machine polling and result delivery remain available to finish it. Regression coverage is in `apps/cloudflare/test/public-account-access.workerd.ts`.

`ALLOW_DEVELOPMENT_AUTH` retains the development admission exception, including signed public requests. Production uses the stored identity's email and verification status for those token paths.

Browser and native admission refusal is `403` with `{ error, code: "account-access-refused", reason }`. A browser's `GET /` document request instead gets a page with the same copy (`ADMISSION_REFUSAL_COPY_V1`) and a sign-out link. No copy says an invitation exists. An authority that cannot answer is `503` with `code: "account-access-unavailable"`, never `401`, so a client does not discard a good sign-in. Routine webhooks and machine enrollments retain their `{ error }` response shape with the same refusal or unavailability copy and `403` or `503` status; a token whose stored identity is missing receives `401`.

## Admin seams

Administration is not in the app. The operations are `app/admin/operations.ts`, mounted by the app Worker's `AdminEntrypoint` (`apps/cloudflare/src/admin-entrypoint.ts`), which is reachable only over a service binding: no HTTP route answers for it, and the client has no administrative surface ([ADR 0028](adr/0028-open-deployment.md)). The one caller is the admin portal, `apps/admin-portal`, a Worker at `admin.frockbot.com` behind its own Cloudflare Access application that checks the Access email against `FROCKBOT_ADMIN_EMAILS` itself.

- `readPolicy` and `setAdmissionMode`: the mode, under `{ schemaVersion: 1, type: "deployment/set-admission-mode", mode, revision }`.
- `listAccounts`: every account with its access record, what it holds, and what it can spend, plus the catalog's admin-gated Plugins. One unreadable account is marked unreadable rather than defaulted, and hides no other.
- `readAccountAccess` and `setAccountAccess`: one account's record, under `{ schemaVersion: 1, type: "account/set-access", state, revision }`. `revision` is `0` for an account with no record.
- `inviteEmail`: `{ schemaVersion: 1, type: "access/invite-email", email }`. This is idempotent, and the address is compared trimmed and lower-cased.
- `setAccountFeatures` and `grantCredit`: what an account holds — Plugin authoring and the admin-gated Plugins opened for it — and complimentary credit, by the grant's own idempotency id.

Both compare-and-swaps answer `{ status: "applied", value }` or `{ status: "conflict", currentRevision }` rather than throwing, because the caller is another Worker; the portal renders a conflict as "changed underneath you" and writes nothing.

An account's features are also writable from the operator surface, `POST /api/debug/users/:userId/features` under the deployment's `DEBUG_TOKEN`: a deployment with no portal still has to be able to turn Plugin authoring on.

Waitlists, invitation email, redemption UI, trial credit and onboarding are not built. They build on these operations rather than beside them.

## Release: retiring the signups switch

The authority replaced `deployment:policy:v1`, which held `signups: { open }`. Nothing decodes that record any more.

- **Cleanup runs by itself.** `cleanRetiredDeploymentPolicyV1` runs whenever the `DeploymentPolicy` object starts. The first request after the deploy starts it. It deletes that one key and writes the receipt `maintenance:retired-signups-policy:2026-09-14`. It is scoped to that key and repeatable: a second start finds the receipt and does nothing. The old switch's value is not carried forward, so the deployment starts in `closed`.
- **Existing Users lose access until granted.** On the initial release, existing non-admin accounts have no access records and the deployment starts closed. They need an explicit grant to sign in while it stays closed, including test accounts that previously signed in. Admins are unaffected.

After the deploy, the person releasing does the following:

1. Open admin.frockbot.com as an administrator and confirm the page loads with **Closed** chosen. This also proves the cleanup ran, because the page reads the authority.
2. For each non-admin test account that should keep access, set its access to **Active** in the account list on that page.
3. Choose the mode the beta should run in.
4. Verify a fresh conversation: as the admin, create a new Bot, send it a message and see it reply. If a test account was granted access, sign in as it and see it reach the app rather than the refusal page.

No production data is deleted beyond the one retired key.
