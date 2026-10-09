# WAAM™ Kajabi Launch Checklist — English & Spanish
Wholistically Aligned LLC · Readiness verified in a real browser (Chromium) against the production Worker logic.

## How it fits together
One Cloudflare Worker does everything: it serves the English page at `/` and the Spanish page at `/es`, and runs the scoring, routing, and Clinical Engine™ behind them. Kajabi shows each page inside an iframe via a small Custom Code snippet. The iframe keeps the assessment's styling completely separate from your Kajabi theme, and resizes itself to fit the content — no inner scrollbar.

## Upload these files to one folder, then deploy
`waam-worker.js`, `wrangler.toml`, `waam_assessment_production.html`, `waam_assessment_production_es.html` — all four together (the Worker bundles the two pages).

The repo also carries `package.json` (pins wrangler), `test-endpoints.mjs` (local check of every endpoint), and `.dev.vars.example`. Copy it to `.dev.vars` for local runs — real secrets go there, never in the `.example` file, which is committed.

## Step 1 — Kajabi settings (mostly done already)
Recovered from the previous live assessment and already filled into BOTH page files:
- `KAJABI.FORM_URL` — subdomain `wholisticallyaligned.mykajabi.com`, forms `2149686351` (EN) / `2149686352` (ES)
- `OFFERS.eating` — Mindful Eating (`TaSkKZJu`)
- `OFFERS.foundation` and `OFFERS.mbsrER` — pointed at MBSR Series I (`2JmdrrJt` EN / `5XY3pjzM` ES) as an interim, matching the previous build

Still needed from the client:
- [ ] `OFFERS.dbt` — DBT Emotional Regulation checkout link (currently falls back to the site homepage)
- [ ] `OFFERS.clinicalReview` — $299 Clinical Review booking link (same fallback)
- [ ] Confirm the foundation mapping, or supply a dedicated Intro-to-MBSR offer
- [ ] The six Kajabi custom-field names, so `/lead` can forward tier / track / WWS / language / domains / type

`WORKER_URL` stays empty — the pages and engine share one address.
`FIELDS` keeps the generic `custom_field_1..6` names until the real ones arrive; they are only used to build the payload the page sends to the Worker.

## Step 2 — Deploy the Worker
1. `npm install -g wrangler` then `wrangler login`
2. In `wrangler.toml`, set `ALLOWED_ORIGINS` to your real Kajabi address(es), e.g. `https://yoursite.mykajabi.com,https://www.wholisticallyaligned.com`. This controls which sites may embed the assessment.
3. Set all three secrets (each prompts for the value; nothing is stored in the repo):
   - `wrangler secret put ANTHROPIC_API_KEY` → your Anthropic Console key
   - `wrangler secret put KAJABI_API_KEY` → Kajabi OAuth **client id**
   - `wrangler secret put KAJABI_API_SECRET` → Kajabi OAuth **client secret**

   Both Kajabi values come from Kajabi → **Settings → Public API** — *not* Account Details, which shows a different, older credential with no rotate option. Without these two, `/lead` returns 500 and lead capture stops silently.
4. `wrangler deploy` → note the URL it prints
5. Check: open `<url>/health` → `{"ok":true}`; open `<url>/` and `<url>/es` directly — both pages should load.
6. Optional: `BASE=<url> node test-endpoints.mjs` runs every endpoint against the deployed Worker — health, both pages, validation, and real `/assess` + `/goals` calls. Add `LEAD_EMAIL=you@example.com` to include a live Kajabi submit (creates a real contact).

## Step 3 — Add to Kajabi
1. In `kajabi_embed_en.html` and `kajabi_embed_es.html`, replace `YOUR-SUBDOMAIN` with your Worker subdomain.
2. Kajabi → Website → your English page → Add block → Custom Code → paste all of `kajabi_embed_en.html` → Save.
3. Repeat on a separate Spanish page with `kajabi_embed_es.html`.
4. For best appearance, place each in a full-width section. If your Kajabi header covers the top of the assessment when moving between steps, adjust `OFFSET` in the snippet (default 90).

## Step 4 — Test before you announce (both pages)
- [ ] Complete the assessment end to end; results, analysis, goals appear in the right language
- [ ] Edit a goal, then download the journal — your edit appears in it
- [ ] $299 review button and each program button open the right Kajabi offer
- [ ] **Kajabi contact check (most important):** after a test run, confirm the contact appears in Kajabi. Lead capture now goes through the Worker's `/lead` endpoint (OAuth + form submit, server-side), which returns a real success or failure instead of the old fire-and-forget browser POST — so if something breaks, the browser console shows it. Verified working on both forms: EN `2149686351`, ES `2149686352`.
- [ ] **Custom fields:** confirm tier / track / WWS / language / domains / type actually land on the contact record. Until the six Kajabi custom-field names are supplied, `/lead` sends name + email only and those values are dropped. The page already sends them to the Worker — only the Kajabi-side mapping is missing.
- [ ] **Follow-up email timing — use an address Kajabi has NEVER seen.** In testing, the automation email arrived roughly 20 minutes after submission. That test address had been submitted six times across earlier rounds, so the delay may simply be Kajabi deprioritising a repeat trigger for an existing contact. Submit once from a genuinely new address and time it. A minute or two means real users are fine; another 20-minute wait is Kajabi's actual delivery latency, worth raising with their support with the submission IDs and timestamps. Note the Worker's own response takes ~1-2 seconds — everything after that is inside Kajabi, and results/analysis/goals never wait on it.
- [ ] Try on a phone
- [ ] Record the public launch date in IDF v2.2 Section 8 and send it to counsel

## Verified in this build
Real-browser test, both languages, on a mock Kajabi page from a separate origin:
Kajabi theme untouched · iframe height stable (no runaway growth) · no inner scrollbar · page scrolls back to the assessment on each step · results render with 7 domain cards, six-month foundation, $299 review · analysis and 5 goals render · iframe grows to fit results · journal opens with the edited goal, name, and 5 monthly pages · zero JavaScript errors.
Also verified: English page gets English prompts, Spanish page gets Spanish prompts in formal *usted*; identical answers score identically in both languages; no scoring weights, prompts, or keys in either page.
