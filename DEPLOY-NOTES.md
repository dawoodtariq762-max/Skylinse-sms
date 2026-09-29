# Skyline SMS Panel — release 2026-09-29 (Skyline branding + SMPP dedup/multipart/UTC fix)

Ye archive **poora updated panel** hai: base = aap ka deployed source, aur us par do cheezen:

1. **Frontend branding: Galaxy → Skyline SMS** (naya, is release ki buniyadi tabdeeli)
2. **SMPP/SMS ingestion ka dedup-v2 fix** (pichhle release ka wahi verified backend code — bilkul same)

**Abhi tak kuch deploy nahi hua**, koi SMSC bind nahi kiya gaya, production database ko haath nahi lagaya gaya.

Andar: poora frontend (13 pages, sab Skyline-branded), `backend/` (fixed), `tests/` (6 suites),
`docs/dedup-v2/` (diagnosis, plan, verification report + dono run logs),
`docs/SKYLINE-BRANDING-NOTES.md` (branding ka record), `backend/scripts/rollback-dedup-v2.js`,
aur `MANIFEST-SHA256.txt` (har file ka sha256).

---

## 1. Frontend branding — kya badla

| Surface | Pehle | Ab |
|---|---|---|
| Login page `/panel-login` | GALAXY logo, "GALAXY SECURE ACCESS", "Welcome to Galaxy SMS" | Skyline lockup, "SKYLINE SECURE ACCESS", "Welcome to Skyline SMS" |
| Admin / Manager / Agent / Client panels | sidebar "GALAXY SMS" + purana logo | sidebar "SKYLINE SMS" + Skyline mark |
| Browser tab + favicon (sab pages) | "GALAXY SMS — …" | "SKYLINE SMS — …", Skyline favicon |
| Baqi 8 pages (management, panel-sharing, payment, test + unke logins) | wahi purana brand | wahi Skyline brand — **koi page purana naam nahi dikhata** |

Naye assets: `assets/skyline-logo.svg|png`, `assets/skyline-lockup.svg|png`, `assets/skyline-favicon.svg|png`.
Purane filenames `galaxy-logo.png`, `galaxy-favicon.png`, `galaxy-icon.png`, `galaxy-appicon.png` **andar se
Skyline artwork** se refresh kar diye gaye hain, is liye kahin bhi purana logo render nahi hota.

Logo white/light theme ke liye banaya gaya hai (blue mark + navy ink), screenshot-verified.

**Sirf frontend badla:** branding ki wajah se `backend/` ki **ek bhi line nahi badli** — is archive ke
saare 21 backend files ka sha256 pichhle (94/0 e2e-verified) archive se **bilkul identical** hai.

---

## 2. Backend SMS fix (pichhle release ka wahi code)

Aap ki policy: fallback **lossless** rahe, 300 s wala content window production me **na chale**, jis message
ka physical id na ho wo **store** ho + `no-id` mark ho + stats me alag gina jaye, aur sirf sender/destination/body
same hone par kuch bhi **silently suppress na ho**.

| hidayat | kaise enforce hui |
|---|---|
| **lossless default** | `SMPP_FALLBACK_RETRY_WINDOW_SECONDS=0`; window **akela kaafi nahi** — effective window tab tak `0` rehta hai jab tak `SMPP_ALLOW_CONTENT_SUPPRESSION=1` bhi set na ho |
| **300 s window off** | window set kar dein magar arm na karein → panel ignore karta hai, boot par warning, aur `/api/smpp/dedup-stats` me `content_suppression_armed: false`, `lossless: true` |
| **no-id messages store** | durable id na ho to hamesha store; `smpp_logs` me saaf entry (`stored without content-based suppression`) |
| **`no-id` marking** | naya column `sms_records.identity_state`: `strong` / `multipart` / `weak` / `no-id` |
| **alag statistics** | `/api/smpp/dedup-stats` → `no_id {last_24h, last_7d, total}` + `identity_states {…}` |
| **identical content par suppression nahi** | koi content hash decision me use nahi hota (TEST 5: 3 bilkul same OTP → teeno store) |

Multipart SMS (UDH concatenation), `message_payload` TLV, aur SMS-day counting **UTC** par — tafseel
`docs/dedup-v2/smpp-fix-verification.md` me (point-by-point mapping + before/after table + limitations).

---

## 3. Archive me kya NAHI hai (jaan bujh kar)

* `node_modules/` — size + native build. Server par: `npm install --omit=dev` (Node >= 20).
  Agar maujooda `node_modules` theek chal raha hai to usay waise hi rehne dein.
* `.env` — sirf `.env.example` hai; apna `.env` server par se hi use karein (`JWT_SECRET` set karein).
* `data.sqlite`, backups, logs — nahi.

---

## 4. Deploy — step by step (VPS)

```bash
# 0) pehle backup (poora folder — sab se mehfooz wapsi)
cd /path/to/panel && cp -a . ../panel-backup-$(date +%F) && cd ..

# 1) upload
scp skyline-sms-panel-2026-09-29.zip user@vps:/tmp/

# 2) extract + integrity check
cd /tmp && unzip -q skyline-sms-panel-2026-09-29.zip -d skyline-release
cd skyline-release && sha256sum -c MANIFEST-SHA256.txt | grep -v ': OK$'
#    (kuch bhi print na ho = saari files theek)

# 3) panel folder me sync karein (apna .env / data.sqlite / node_modules waise hi rahenge)
rsync -a --exclude '.env' --exclude 'data.sqlite' --exclude 'node_modules' ./ /path/to/panel/
#    Sirf branding chahiye (backend wapas na chhedna ho) to itna kaafi hai:
#    cp -f *.html api.js /path/to/panel/ && cp -f assets/* /path/to/panel/assets/

# 4) dependencies (agar node_modules maujood hai to skip)
cd /path/to/panel && npm install --omit=dev

# 5) restart
pm2 restart galaxy-sms --update-env && pm2 logs galaxy-sms --lines 80
#    expected boot lines:
#      • [SMPP] lossless mode: nothing is ever suppressed because the content looks identical …
#      • [DEDUP-V2] migration complete
#        (pehli baar migration chalne par is se pehle ek line aati hai:
#         • [DEDUP-V2] pre-migration backup: data.sqlite.pre-dedup-v2-<date>)
```

### Verify karein

**Frontend:** browser me `/panel-login` kholein → Skyline lockup + "SKYLINE SECURE ACCESS" nazar aaye;
tab ka title "SKYLINE SMS — Login"; favicon Skyline. Purana logo dikhe to hard-refresh (Ctrl+Shift+R) —
images `?v=skyline-1` se cache-busted hain.

**Backend (admin token):**

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/smpp/dedup-stats | head -40
#    expect: "lossless": true, "content_suppression_armed": false, aur ek "no_id" block
```

---

## 5. Rollback

* **Frontend:** `panel-backup-<date>` se `*.html`, `api.js`, `assets/` wapas copy kar dein (server restart ki zaroorat nahi).
* **Backend (migration wapas):** panel band kar ke:

```bash
node backend/scripts/rollback-dedup-v2.js                 # dry run: inventory + kya hoga
node backend/scripts/rollback-dedup-v2.js --apply         # sirf do nayi tables drop
node backend/scripts/rollback-dedup-v2.js --apply --clear-identities --reset-meta --force
```

Rollback likhne se pehle `VACUUM INTO` se consistent snapshot banata hai, adhoore multipart parts hone par
`--force` ke bina `smpp_parts` drop nahi karta, kisi SMS row ko delete ya edit nahi karta.

* **Poora folder:** `rm -rf /path/to/panel && mv ../panel-backup-<date> /path/to/panel && pm2 restart galaxy-sms`.

---

## 6. Env knobs

| env | default | matlab |
|---|---|---|
| `SMPP_ID_TLVS` | `0x001e` | kaun se TLV provider message-id ginein |
| `SMPP_ID_APPENDED` | `0` | `1` = provider agar body me id append karta hai to usay bhi identity maano |
| `SMPP_FALLBACK_RETRY_WINDOW_SECONDS` | `0` | window (seconds) — akela kaam nahi karta |
| `SMPP_ALLOW_CONTENT_SUPPRESSION` | `0` | `1` = window ko arm karo. **Production me off rakhna hai** |
| `SMPP_PARTS_MAX_AGE_SECONDS` | `300` | itne baad adhoora multipart partial row ban kar store ho jata hai (delete nahi) |
| `SMPP_CROSS_CHANNEL_IDENTITY` | `0` | `1` = SMPP aur API channel ids ek namespace |

---

## 7. Saboot (verification)

* **Branding (browser, real server):** 5 surfaces (login + admin/manager/agent/client) — Skyline title,
  sidebar "SKYLINE SMS", logo file load, Skyline favicon, **zero** "Galaxy" text, zero broken images;
  before/after screenshots workspace me (`verify/shots-skyline/`, `verify/shots-before/`).
* `node tests/ui-theme.test.js` → **27/27 pass** (UI/branding contract)
* `node tests/unit_identity.js` → **PASS 29 / FAIL 0**
* `node tests/smoke_endpoints.js` → **PASS 18 / FAIL 0**
* `node tests/e2e_mock_smsc.js` → **PASS 94 / FAIL 0** (asli panel + asli SQLite + TCP mock SMSC;
  purane code par wahi suite: 29 pass / 47 fail) — ye backend code pichhle archive me chala chuka hai,
  aur is archive me `backend/` ke saare files us se **sha256-identical** hain.

---

## 8. Is release ke baad bhi kya baqi hai

* **PM2 app ka naam** (`galaxy-sms`), `ecosystem.config.js`, aur backend ka startup banner abhi bhi purana
  naam lete hain — ye backend/ops hain, "full rebrand" wale pass me badlenge (aap ne abhi rok rakha hai).
* Asset **filenames** `galaxy.css` / `galaxy.js` abhi wahi hain (sirf naam; andar ka brand text Skyline hai).
* Daily SMS **limits** abhi bhi UK day par reset hoti hain (reporting/counting UTC par hai) — client-visible
  behaviour hai, is liye jaan kar waisa chhoda gaya.
* Purane duplicate rows delete nahi kiye — A7 query se sirf dekh sakte hain.
* Koi live SMSC bind nahi, koi production DB touch nahi, kuch deploy nahi.
