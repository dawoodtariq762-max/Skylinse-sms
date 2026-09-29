# SMPP ingestion fix — implementation plan (approved scope: "implement the fixes")

Working copy: `/home/user/panel-fix` (copy of the deployed source `panel-src` @ `fbee64e`; the pristine copy is kept untouched for diffing and before/after tests).
Nothing is deployed: no production DB touched, no bind to the SMSC attempted, no data deleted.

## 1. Files that will be modified

| file | change |
|---|---|
| `backend/smppIdentity.js` | **new** — pure helpers: raw-PDU parser, TLV/identity extraction, UDH decoder, canonical body hash. No DB, no network, fully unit-testable. |
| `backend/smppService.js` | identity-first dedup, DB-backed multipart assembly, `message_payload` fix, safe error/ACK ordering, durable ledger writes, identity diagnostics, logging |
| `backend/schema.js` | new tables/columns (additive, idempotent) + guarded migration + pre-migration backup |
| `backend/server.js` | exact `lastInsertRowid` attribution, post-insert bookkeeping isolation, optional `dedup_identity` on insert, UTC day windows for SMS counts, failed-SMS retry idempotency, stop wiping the replay ledger, `connection_uid` handling |
| `backend/providerSync.js` | record a provider identity in the shared ledger **only** when it is configured as equivalent to the SMPP identity; otherwise preserve both (documented limitation) |

Untouched on purpose: roles, permissions, rate cards, allocations, payments/payout scheduling, provider credentials, unrelated reports, historical SMS rows.

## 2. Schema changes (all additive, reversible, no rewrite of existing rows)

```sql
-- durable replay ledger (replaces smpp_seen for new traffic; smpp_seen is kept as history)
CREATE TABLE IF NOT EXISTS sms_dedup_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_uid  TEXT NOT NULL,          -- stable SMSC-account identity (see §3)
  identity_kind   TEXT NOT NULL,          -- mid | tlv:0x001e | mp:… | pdu:… | api:…
  identity        TEXT NOT NULL,          -- the identity value (hash for content kinds)
  channel         TEXT DEFAULT 'smpp',    -- smpp | api_sync | carrier_http
  sms_record_id   INTEGER,                -- row created by this identity (lastInsertRowid)
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL DEFAULT '',
  acked_at        TEXT DEFAULT '',        -- when deliver_sm_resp was flushed (retry evidence)
  seen_count      INTEGER DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_dedup_unique ON sms_dedup_ledger(connection_uid, identity_kind, identity);

-- multipart assembly, restart-safe (a process restart no longer loses pending parts)
CREATE TABLE IF NOT EXISTS smpp_parts (
  connection_uid TEXT NOT NULL,
  group_key      TEXT NOT NULL,           -- src|dst|concat-ref|total
  seq            INTEGER NOT NULL,
  part_identity  TEXT NOT NULL,           -- identity of THIS part (retry detection)
  text           TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  PRIMARY KEY (connection_uid, group_key, seq)
);

ALTER TABLE smpp_connections ADD COLUMN connection_uid TEXT DEFAULT '';   -- backfilled from host|port|system_id
ALTER TABLE sms_records      ADD COLUMN dedup_identity TEXT DEFAULT '';   -- populated ONLY for strong identities
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_records_dedup_strong
  ON sms_records(dedup_identity) WHERE dedup_identity <> '';             -- partial: content keys never enter
ALTER TABLE failed_sms_queue ADD COLUMN dedup_identity TEXT DEFAULT '';
ALTER TABLE failed_sms_queue ADD COLUMN sms_record_id  INTEGER;           -- links a failed row to a stored SMS
```

Guards: `ensureColumn()` for columns, `CREATE TABLE/INDEX IF NOT EXISTS` for the rest, a `dedup_v2_migrated` meta marker, and a **file backup before the migration** (`data.sqlite.pre-dedup-v2-<ts>`, skipped if one already exists for that day). Reversal script: `backend/scripts/rollback-dedup-v2.js` (drops the two new tables and the partial index; keeps `connection_uid`/`dedup_identity` as harmless empty columns because SQLite `DROP COLUMN` is version-dependent — documented).
Seeding: only `smpp_seen` keys that are **strong** (`mid:*`) are copied into the ledger. `fp:*` fingerprint keys are **not** seeded (they could suppress a genuine future identical SMS).

## 3. Dedup identity design

Priority order for every inbound PDU (first match wins):

| # | identity | source | strength | retention |
|---|---|---|---|---|
| 1 | `tlv:<tag>` / `mid:<value>` | SMSC message id present in the PDU — configured ID TLVs (`SMPP_ID_TLVS`, default only `0x001E receipted_message_id`) or a verified non-standard appended `message_id` cstring (opt-in `SMPP_ID_APPENDED=1`, format-validated) | **strong** — identical for a retry, different for a new message | forever |
| 2 | `mp:<sha1(src\|dst\|ref\|total\|seq\|parthash)>` | multipart part, from UDH concat IE | strong-ish, structure+content, window-scoped | assembly window |
| 3 | `pdu:<sha1(canonical body)>` | no id available — **off by default** | **weak** — cannot distinguish retry from genuine identical resend | `SMPP_FALLBACK_RETRY_WINDOW_SECONDS` (default `0` = never suppress) |

If tiers 1 and 2 are unavailable and the fallback window is 0 (default) the message is **always stored** and an `ident` log line is emitted (rate-limited) so the operator can see that the SMSC provides no durable id and decide whether to enable the window.

- Identity extraction is discovered empirically: the panel logs, once per connection, which TLVs/fields the SMSC actually sends (tag + value length + hex prefix of unrecognised trailing bytes) — **without** logging message content.
- Configured TLVs are only trusted when their value is non-empty and stable-looking; a tag whose value repeats across messages is rejected as an identity (logged).

## 4. How the four cases are distinguished

| case | evidence used | result |
|---|---|---|
| **Retry of the same physical SMS** | same strong identity (tier 1) on the same `connection_uid` — survives +12 s, +1 min, +5 min, reconnect, restart, connection delete/recreate | suppress, ACK `ESME_ROK`, log `dedup suppressed (mid:…)` |
| **Genuine resend (same src/dst/text, new message)** | **different** strong identity | stored as a new row; never compared by content |
| **Multipart part** | UDH concat IE: IEI 0x00 (8-bit ref) / 0x08 (16-bit ref) + total + seq, matched against the same `(connection_uid, src, dst, ref, total)` group | part is joined; the group yields **one** row when complete; a part with the same seq but different text starts a new group (never merged) |
| **Independent SMS** | no concat IE, or a different group key | its own row, even if the text is byte-identical to another message |

Without a strong identity, case 1 and case 2 are *information-theoretically indistinguishable*; the system then prefers storage over suppression and says so in the logs (see §7 of the report).

## 5. Error/ACK ordering (§4 of the request)

- The store (`INSERT INTO sms_records` + ledger write) decides the ACK. If the store succeeds → `ESME_ROK`, always.
- Post-insert bookkeeping (stats, payment ledger, sharing forward, webhook log) is isolated in its own try/catch: it can no longer turn a stored message into `ESME_RSYSERR` (which told the SMSC to resend a message we already had).
- If the store itself fails → non-zero status so the SMSC retries; nothing is falsely claimed as processed.
- The dedup ledger row is written with the **exact** `lastInsertRowid` of that insert (no `ORDER BY id DESC LIMIT 1`).

## 6. Tests (before/after)

1. `unit` — UDH 8/16-bit decode, multipart grouping, `message_payload`, raw-PDU identity extraction (TLV / appended id / none), canonical hash, UTC day windows.
2. `e2e` — real panel process + mock SMSC over TCP, real SQLite: the 14-scenario matrix from the request, run twice (old code vs new code) for a before/after table.
3. Audit queries A1–A7 against the test database (the production DB is not in this workspace — the exact commands are provided for the operator to run).
