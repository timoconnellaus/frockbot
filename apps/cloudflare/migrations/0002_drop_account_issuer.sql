-- `account.issuer` belonged to Better Auth 1.7.0 through 1.7.2. From 1.7.3 the
-- library neither writes it nor looks accounts up by it — it keys on
-- (providerId, accountId) — and it refuses to serve `/api/auth/*` at all while
-- a column it never writes is `not null`, so the column and its unique index
-- have to go rather than be kept nullable.
drop index if exists "account_issuer_accountId_uidx";

alter table "account" drop column "issuer";
