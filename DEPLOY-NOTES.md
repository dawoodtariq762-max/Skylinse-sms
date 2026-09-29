# Galaxy SMS Panel — Dedup / Multipart / UTC-day fix (release 2026-09-29)

Ye archive **poora updated panel** hai: base = aap ka deployed source (`fbee64e`), us par
SMPP/SMS ingestion ka fix laga hua. **Abhi tak kuch bhi deploy nahi hua**, koi SMSC bind
nahi kiya gaya, production database ko haath nahi lagaya gaya.

Andar kya hai: `backend/` (fixed), `tests/` (naye test suites), `docs/dedup-v2/` (diagnosis,
plan, verification report), `backend/scripts/rollback-dedup-v2.js` (wapsi ka tool).

---

## 1. Kya badla (sirf ye files)

| file | kaam |
|---|---|
| `backend/smppIdentity.js` | **naya** — raw PDU parse, TLV 0x001E / appended-id, UDH decode, multipart identity, canonical hash, SMSC-account identity |
| `backend/dayWindow.js` | **naya** — UTC SMS-day helpers (sirf SMS counting; payments UK hi rehte hain) |
| `backend/smppService.js` | identity-first ingest, durable ledger, `smpp_parts` multipart, `message_payload` fix, sahi ACK order |
| `backend/server.js` | exact `lastInsertRowid`, dedup identity insert + pre-check, UTC day windows, retry idempotency, `connection_uid`, `/api/smpp/dedup-stats` |
| `backend/schema.js` | additive tables/columns/indexes + guarded, backed-up `migrateDedupV2()` |
| `backend/providerSync.js` | provider reference ledger me record (cross-channel sirf opt-in) |
| `backend/scripts/rollback-dedup-v2.js` | **naya** — rollback (dry-run default) |
| `tests/unit_identity.js`, `tests/e2e_mock_smsc.js`, `tests/lib/mock_smsc.js`, `tests/restart_child.js`, `tests/window_policy_child.js`, `tests/smoke_endpoints.js` | **naye** test suites |
| `docs/dedup-v2/*` | diagnosis, plan, verification report (before/after har check) |

Baqi sab files (frontend, admin/agent/client.html, deploy/, ecosystem config, roles, rates,
allocations, payments, provider credentials) **jaisi thi waisi hai**.

---

## 2. Archive me kya NAHI hai (jaan bujh kar)

* `node_modules/` — archive me nahi (size + native build). Server par:
  `npm install --omit=dev` (Node >= 20; `better-sqlite3` native module dobara build hoga).
  Agar aap ka maujooda `node_modules` theek chal raha hai to usay **jaise hai waisa rehne dein** —
  dependencies badli nahi gayi hain.
* `.env` — kabhi include nahi kiya jata (sirf `.env.example` archive me hai). Apna `.env`
  server par se hi use karein; `JWT_SECRET` set karna na bhoolein.
* `data.sqlite`, backups, logs — archive me nahi.

---

## 3. Deploy (jab aap faisla kar lein)

```bash
# 1) backup — zaroori
cd /path/to/panel
cp backend/data.sqlite backend/data.sqlite.bak-$(date +%F)

# 2) panel band karein
pm2 stop galaxy-sms            # ya: pm2 stop powerx-api powerx-sync

# 3) ye files replace karein (archive se)
#    backend/smppIdentity.js  backend/dayWindow.js  backend/smppService.js
#    backend/server.js        backend/schema.js     backend/providerSync.js
#    backend/scripts/rollback-dedup-v2.js          (naya, folder bana lein)
#    chahein to tests/ aur docs/dedup-v2/ bhi rakh lein — production inhe parhta nahi

# 4) start + log dekhein
pm2 start galaxy-sms && pm2 logs galaxy-sms --lines 80
#    expected:
#      • [DEDUP-V2] pre-migration backup: data.sqlite.pre-dedup-v2-<date>
#      • [DEDUP-V2] ledger seeded from strong keys: N (fp:* fingerprint keys intentionally NOT seeded)
#      • [DEDUP-V2] migration complete (backup ready)
#      • SMPP service active ... -> bind -> status bound

# 5) naya admin endpoint (read-only)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/smpp/dedup-stats
```

Migration **additive** hai: purani rows ko chhota nahi karta, koi SMS record delete nahi hota,
koi timestamp edit nahi hota. Pehle se `<db>.pre-dedup-v2-<date>` backup bhi apne aap banta hai.
Split deploy (`powerx-api` + `powerx-sync`, ek hi SQLite) me jo process pehle uthega wahi migration
chalayega — `meta.dedup_v2_migrated` key usay dobara nahi chalne deti.

### Rollback (agar kuch ghalat lage)

```bash
pm2 stop galaxy-sms
node backend/scripts/rollback-dedup-v2.js                          # dry run, inventory print karta hai
node backend/scripts/rollback-dedup-v2.js --yes --clear-columns    # pre-fix behaviour, SMS rows salamat
node backend/scripts/rollback-dedup-v2.js --yes --restore-backup   # pre-migration backup file wapas
pm2 start galaxy-sms
```

---

## 4. Env knobs (sab optional — default theek hai)

| env | default | matlab |
|---|---|---|
| `SMPP_ID_TLVS` | `0x001e` | kaun se TLV provider message-id ginein (`receipted_message_id`) |
| `SMPP_ID_APPENDED` | `0` | `1` = provider agar body me id append karta hai to usay bhi identity maano |
| `SMPP_FALLBACK_RETRY_WINDOW_SECONDS` | `0` | `0` = kuch bhi content se suppress na karo (lossless). `>0` = is window ke andar **bilkul same** SMS ko retry maan kar chhod dein (asli duplicate-OTP bhi chhup sakta hai) |
| `SMPP_PARTS_MAX_AGE_SECONDS` | `300` | itne waqt baad adhoora multipart ek partial row ke tor par store ho jata hai (delete nahi hota) |
| `SMPP_CROSS_CHANNEL_IDENTITY` | `0` | `1` = SMPP aur API channel ke ids ek hi namespace (tab hi cross-channel dedup hota hai) |

**Faisla aap ka hai:** live provider koi per-message id nahi bhejta (measure kiya gaya). Is liye
shipped default **lossless** hai — retry dobara store ho jata hai, lekin kuch bhi silently drop
nahi hota, aur har no-id message `smpp_logs` (event `ident`) me log + `/api/smpp/dedup-stats` me
count hota hai. Agar duplicates se zyada tang hain aur "same OTP dobara" ka theoretical loss
manzoor hai, to `SMPP_FALLBACK_RETRY_WINDOW_SECONDS=300` laga dein.

---

## 5. Saboot (verification)

* poori report: `docs/dedup-v2/smpp-fix-verification.md` — check-by-check before/after table,
  A1–A7 audit queries + unke measured results, deploy checklist, aur saari known limitations.
* unit tests: `node tests/unit_identity.js` → **24/24**
* end-to-end (asli panel + mock SMSC over TCP + asli SQLite): `node tests/e2e_mock_smsc.js`
  → **79/79** (purane code par wahi suite: 30 pass / 35 fail)
* endpoint smoke: `node tests/smoke_endpoints.js` → **15/15**

Tests ko chalane ke liye `node_modules` chahiye (archive me nahi hai) — server par `npm install` ke
baad ye commands chal jayengi. e2e suite real timings leti hai (retry/reconnect ke intervals ke
dauraan soti hai), aur fail hone par apna DATA_DIR rakh deti hai taake aap DB dekh sakein.

---

## 6. Is release ke baad kya nahi hua

* Koi live SMSC bind nahi, koi production DB touch nahi, kuch deploy nahi.
* Purane duplicated rows delete nahi kiye (report me A8 query se sirf **dekh** sakte hain).
* Daily SMS **limits** abhi bhi UK day par reset hoti hain (reporting UTC par hai) — chahein to
  ek line ka change hai.
* `webhook_logs` ka purana intake message text likhta hai (pehle se aisa tha, chheda nahi).

---

## 7. Archive ki verification (is zip ko extract kar ke chalaya gaya hai)

1. Zip ko ek saaf folder me extract kiya, `node_modules` ko maujooda `panel-src/node_modules` se
   link kiya, aur usi extracted copy par suites chalayi:
   * `node tests/unit_identity.js` → **PASS 24  FAIL 0**
   * `node tests/smoke_endpoints.js` → **PASS 15  FAIL 0**
   * `node tests/e2e_mock_smsc.js` (asli TCP + SQLite) → **PASS 79  FAIL 0**
2. Sab badli hui files byte-identical hain working copy se — `MANIFEST-SHA256.txt` me har file ka
   sha256 hai, deploy ke baad `sha256sum -c` se check kar sakte hain (paths archive root se relative).

Deploy ke baad sab se pehla check: `pm2 logs` me `[DEDUP-V2] migration complete` line, aur
`/api/smpp/dedup-stats` ka jawab.
