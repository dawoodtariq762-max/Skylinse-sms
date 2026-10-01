# Skyline SMS Panel — release 2026-09-30 r2 (Show Records "All" + Detailed Report Range/User filters)

Ye archive **poora updated panel** hai: base = aap ka deployed source, aur us par ye cheezen:

1. **Rate/payout hierarchy fix + report column order + dashboard shortcut cards removal** (is release ke 3 changes — neeche section 0)
2. **Frontend branding: Galaxy → Skyline SMS**
3. **SMPP/SMS ingestion ka dedup-v2 fix** (pichhle release ka wahi verified backend code — bilkul same)

**Abhi tak kuch deploy nahi hua**, koi SMSC bind nahi kiya gaya, production database ko haath nahi lagaya gaya.

Andar: poora frontend (13 pages, sab Skyline-branded), `backend/` (fixed), `tests/` (6 suites),
`docs/dedup-v2/` (diagnosis, plan, verification report + dono run logs),
`docs/SKYLINE-BRANDING-NOTES.md` (branding ka record), `backend/scripts/rollback-dedup-v2.js`,
aur `MANIFEST-SHA256.txt` (har file ka sha256).

---

## 0b. r2 me ye 2 chhoti tabdeeliyan (2026-09-30)

1. **"All" option Show Records me** — SMS CDR / Show Records ke records-per-page dropdown me
   aakhri option **All** add kiya; select karne par us page ki saari matching records aati hain
   (pagination 1 page). Purane numeric options (25/50/100/250/500/1000/2500/5000/10000 waghera)
   waise hi hain — sirf All end me joda gaya. Ye **har role** ke liye laga hai (Admin/Manager/Agent/Client),
   dono report screens (SMS Report + SMS Detailed Report) aur baqi list screens par bhi — kyunke ye list
   `api.js` me ek hi jagah (per-role) define hoti hai aur sab Show-Records selects ko wahi list milti hai.
2. **Range + User filters Detailed Reports me** — wahi **searchable dropdown** jo normal SMS Report me hai
   ab teen detailed reports me bhi laga diya:
   * Admin → SMS Detailed Report: **All Ranges + All Managers**
   * Manager → SMS Detailed Report: **All Ranges + All Agents**
   * Agent → SMS Detailed Report: **All Ranges + All Clients**
   * Client → SMS Report ( uska ek hi report section): **All Ranges** (pehle se maujood tha, verify kiya gaya)
   Search box, A-Z list, "All …" default aur pick karne par report turant filter — sab bilkul SMS Report jaisa.
   Normal SMS Report ke filters **koi tabdeeli nahi** (regression test me verify kiya gaya).

Bas itna hi: rates / payouts / SMS logic / database logic / layout ko haath nahi lagaya.

### r2 verification (extracted archive par)

| Check | Result |
|---|---|
| Browser acceptance (2 changes × 4 panels): options order, "All" = poori list, dropdowns search + asli filtering | **PASS 54 / FAIL 0** |
| Existing SMS Report filters regression (widget + search + data filtering) | **PASS 7 / FAIL 0** |
| `tests/unit_identity.js` | PASS 29 / FAIL 0 |
| `tests/smoke_endpoints.js` | PASS 18 / FAIL 0 |
| `tests/ui-theme.test.js` | 27 / 27 |
| `tests/rate-hierarchy-test.js` (rates untouched) | PASS 99 / FAIL 0 |
| `tests/verify-hierarchy-rates.js` | PASS 74 / FAIL 0 |
| `tests/e2e_mock_smsc.js` (E2E_SPEED=0.1) | PASS 94 / FAIL 0 |

---

## 0. Is release me kya badla (2026-09-30) — sirf 3 cheezen

1. **Dashboard shortcut cards hata diye** — Admin, Manager, Agent aur Client ke **main dashboard** se
   shortcut cards/tiles (My Numbers, My Clients, Self Allocate, Detail Report, Credit Note, Range
   Allocation, Managers/Agents/Clients, Detailed Reports) remove; dashboard ab seedha apne
   Today OTPs / statistics section se shuru hota hai. **Sidebar / navigation waisi hi hai** aur
   saare sidebar items pehle ki tarah kaam karte hain (click kar ke verify kiya gaya).
2. **Rate / payout hierarchy theek ki** (display + calculation dono):
   * Admin -> Manager/Agent: Admin ka diya hua rate **usi allocation ka effective rate** hai; Admin panel
     ki apni payout calculation usi level ka rate leti hai (range 0.012 par 0.014 diya to 0.014 — kabhi
     card par wapas fallback nahi).
   * Rate khali chhorne par woh level ka apna default chalता hai: Manager = Rate Management default,
     Agent = **Manager se mila hua rate** (Admin->Agent direct ho to rate-card default), Client = **0**.
     Khali rate kisi dusre level ki row me **likha nahi jata** (cross-level write khatam).
   * Manager -> Agent: Agent ko Manager ka mila hua rate default dikhta hai, Manager badal sakta hai;
     Manager ki apni payment hamesha Manager-level rate par hoti hai (kabhi Agent ke rate par nahi).
   * Agent -> Client: default **0.00**, badla to wahi value; client ko **sirf apna assigned rate** dikhta
     hai — agent ka purchase rate / range card / Admin rate / koi margin kabhi nahi (payload se bhi stripop).
   * Agent **self-allocate** bhi apne level par manager se mila hua rate rakhta hai (raw range card nahi).
3. **SMS Report / SMS Detail Report column order** — Date -> Range -> Number -> (Admin: Manager,
   Manager: Agent, Agent: Client, Client: Client) -> CLI -> Message Body -> Rate/Payout -> baqi columns
   (Currency etc.). Koi data remove nahi kiya; sorting/filters/pagination waisi hi kaam karti hain.
   Grouped mode ke dimension boxes bhi usi order me hain.

### Verification (extracted copy par, is release me shamil)

| Suite | Natija |
|---|---|
| `node rate-hierarchy-test.js <port>` (naya, 99 assertions: A–H) | **PASS 99 / FAIL 0** |
| `node tests/verify-hierarchy-rates.js` (panel ki apni suite) | **PASS 74 / FAIL 0** |
| `node tests/unit_identity.js` | PASS 29 / FAIL 0 |
| `node tests/smoke_endpoints.js` | PASS 18 / FAIL 0 |
| `node tests/ui-theme.test.js` | 27 / 27 |
| `E2E_SPEED=0.1 node tests/e2e_mock_smsc.js` | PASS 94 / FAIL 0 |
| Browser (puppeteer) — 3 changes, 4 panels | PASS 45 / FAIL 0 + 9/9 rate-default checks |

Naya test `tests/rate-hierarchy-test.js` chalane ka tareeqa: `node tests/rate-hierarchy-test.js 4899`
(folder root se; apna throw-away DATA_DIR khud banata hai, production DB ko touch nahi karta).

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
