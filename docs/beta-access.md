# Beta access

Signing in proves who someone is. It does not give them FrockBot. Access is decided by one authority, the singleton `DeploymentPolicy` Durable Object (`apps/cloudflare/src/deployment-policy.ts`), and the rule it applies is `evaluateAdmissionV1` (`apps/cloudflare/src/account-admission.ts`).

## The rule

The deployment has one **admission mode**:

- `closed`: no new accounts. The default.
- `invite-only`: invited accounts become active on their next sign-in.
- `open`: any account without a record becomes active on its next sign-in.

Each account may have an **access record** keyed by its User id, in one of five states: `invited`, `active`, `paused`, `ended` or `blocked`.

The authority applies these checks in order:

1. A deployment admin (`FROCKBOT_ADMIN_EMAILS`) is admitted. No record is read or written. The Worker answers for an admin without calling the authority, so admins still get in while it is down.
2. An account with a record is decided by that record. `active` is admitted. `paused`, `ended` and `blocked` are refused in every mode, including `open`. `invited` becomes `active` unless the mode is `closed`.
3. An account with no record is admitted if an email invitation matches its **verified** email. The invitation is spent in the same transaction, unless the mode is `closed`, which keeps it for later.
4. Otherwise the mode decides. `open` activates the account. `invite-only` refuses it as `invitation-required`, and `closed` refuses it as `admission-closed`.

Admission itself only ever writes `active` over no record or over `invited`. It never lifts a pause, end or block. Every decision and every write happens inside one synchronous storage transaction in the one object, so a sign-in and an admin change cannot interleave. Admin writes are compare-and-swap on the record's revision, and admission advances that revision too. An admin who acts on a stale read gets a `409`; nothing is silently overwritten.

A provisioned User, an existing better-auth identity or a live session are not access. An account with none of the above is refused however long it has existed.

## Where it is asked

- **Identity creation.** better-auth's `user.create.before` hook (`identityCreationHooksV1`) asks `mayCreateIdentity`. A closed deployment writes no `user` row. An invite-only deployment writes one only for an invited, verified address.
- **Every browser request.** The gateway asks `admitAccount` after resolving the session and before anything reaches a User Durable Object. A pause takes effect on the account's next request.
- **Every native request.** `nativeAuth.authenticate` asks before reading the session record, because that read provisions the User. The exchange asks before issuing a session, and the settings handoff asks through `authenticate`. Sign-out asks too: a refused account's bearer is answered as signed out without provisioning the User to record it. The gateway reuses the native answer rather than asking twice.

A refusal is `403` with `{ error, code: "account-access-refused", reason }`. A browser's document request instead gets a page with the same copy (`ADMISSION_REFUSAL_COPY_V1`) and a sign-out link. No copy says an invitation exists. An authority that cannot answer is `503` with `code: "account-access-unavailable"`, never `401`, so a client does not discard a good sign-in.

## Admin seams

These are JSON routes on the admin Contribution (`app/admin/backend.ts`). They have no UI beyond the mode choice on Site administration.

- `GET` or `POST /api/admin/policy`: the mode, `{ schemaVersion: 1, type: "deployment/set-admission-mode", mode, revision }`.
- `GET` or `POST /api/admin/users/:userId/access`: one account's record, `{ schemaVersion: 1, type: "account/set-access", state, revision }`. `revision` is `0` for an account with no record.
- `POST /api/admin/invitations`: `{ schemaVersion: 1, type: "access/invite-email", email }`. This is idempotent, and the address is compared trimmed and lower-cased.

Waitlists, invitation email, redemption UI, trial credit and onboarding are not built. They build on these RPCs rather than beside them.

## Release: retiring the signups switch

The authority replaced `deployment:policy:v1`, which held `signups: { open }`. Nothing decodes that record any more.

- **Cleanup runs by itself.** `cleanRetiredDeploymentPolicyV1` runs whenever the `DeploymentPolicy` object starts. The first request after the deploy starts it. It deletes that one key and writes the receipt `maintenance:retired-signups-policy:2026-09-14`. It is scoped to that key and repeatable: a second start finds the receipt and does nothing. The old switch's value is not carried forward, so the deployment starts in `closed`.
- **Existing Users lose access until granted.** No non-admin account has a record after the release, so every non-admin User, including test accounts that used to sign in, is refused until an admin gives it one. Admins are unaffected.

After the deploy, the person releasing does the following:

1. Sign in as an admin at bot.frockbot.com. Open **Site administration** and confirm it loads with **Closed** chosen. This also proves the cleanup ran, because the page reads the authority.
2. For each non-admin test account that should keep access, look up its id in the account list on the same page. Then, from the signed-in admin browser's console, run:

   ```js
   await fetch(`/api/admin/users/${encodeURIComponent(userId)}/access`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({
       schemaVersion: 1,
       type: "account/set-access",
       state: "active",
       revision: 0,
     }),
   }).then((r) => r.json());
   ```

3. Choose the mode the beta should run in.
4. Verify a fresh conversation: as the admin, create a new Bot, send it a message and see it reply. If a test account was granted access, sign in as it and see it reach the app rather than the refusal page.

No production data is deleted beyond the one retired key.
