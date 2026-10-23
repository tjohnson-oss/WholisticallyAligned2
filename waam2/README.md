# WAAM™ Assessment Engine

One Cloudflare Worker does everything: it serves the English assessment at `/`
and the Spanish at `/es`, and runs the scoring, routing, Clinical Engine™
narrative and goal generation behind them. Kajabi pages embed those two URLs in
an iframe, so the assessment's styling stays independent of the Kajabi theme and
fixes ship by deploying the Worker — nothing is ever re-pasted into Kajabi.

Live at `https://waam-engine.wholisticallyaligned.workers.dev`.

## Files

| file | purpose |
|---|---|
| `waam-worker.js` | the whole engine: pages, scoring, paywall, Kajabi sync |
| `waam_assessment_production.html` | English page, bundled into the Worker as a text module |
| `waam_assessment_production_es.html` | Spanish page, same |
| `wrangler.toml` | bindings, vars, KV namespace, cron schedule |
| `kajabi-embed-en.html` / `-es.html` | paste into the two assessment pages |
| `kajabi-embed-results-en.html` / `-es.html` | paste into the two post-purchase pages |
| `KAJABI_EMBED.md` | which snippet goes on which page, and what to verify |
| `test-endpoints.mjs` | end-to-end check of every endpoint |

## Which Kajabi page holds what

| Kajabi page | snippet | iframe target |
|---|---|---|
| `/assesment` (one `s`) | `kajabi-embed-en.html` | `/` |
| `/assessment-es` (two `s`) | `kajabi-embed-es.html` | `/es` |
| `/assesment-result` | `kajabi-embed-results-en.html` | `/?tier=results` |
| `/assesment-result-es` | `kajabi-embed-results-es.html` | `/es?tier=results` |

## Deploy

```
npx wrangler login
npx wrangler deploy
```

`ALLOWED_ORIGINS` and `STRICT_PURCHASE` live in `wrangler.toml`. Everything else
is a secret and is never committed:

```
npx wrangler secret put ANTHROPIC_API_KEY    # Clinical Engine narrative + goals
npx wrangler secret put HOOK_SECRET          # guards /hook and /sync
npx wrangler secret put KAJABI_API_KEY       # Kajabi Public API (purchase sync)
npx wrangler secret put KAJABI_API_SECRET
```

Put the same values in `.dev.vars` (gitignored) for local runs and for
`test-endpoints.mjs`. `.dev.vars.example` is the committed template.

A deploy prints the secrets it can see; check all four are listed as
`secret_text` with `npx wrangler secret list`. Adding one through the Cloudflare
dashboard defaults to a plain *Variable*, which the dashboard then offers to
sync into `wrangler.toml` — in a public repo that publishes the key. Always use
`wrangler secret put`.

## Endpoints

| route | who calls it | notes |
|---|---|---|
| `GET /`, `GET /es` | Kajabi iframes | the two pages |
| `GET /health` | monitoring | `{ok, storage}` |
| `POST /submit` | the page | stores answers, returns only the safety flag |
| `POST /results` | the page | **paywalled**; full scores, analysis, goals |
| `POST /goals`, `/nd` | the page | goal regeneration, neurodivergence screen |
| `POST /lead` | the page | posts the seven outcome fields to the Kajabi form |
| `POST /hook` | Kajabi (if ever wired) | records a purchase; needs `X-WAAM-Secret` |
| `POST /sync` | operator | runs the purchase poll; needs `X-WAAM-Secret` |
| `POST /forget` | the page | deletes the answers record |

## How purchases unlock results

Kajabi's "default notification" is an admin email, not an outbound webhook, so
`/hook` is never called on its own. The Worker polls instead: a 5-minute cron
walks `/purchases` newest-first, stops at a stored watermark, and records every
purchase on a WAAM offer. `/sync` runs the same thing by hand — `since:""`
backfills, `dryRun:true` reports without writing.

Two Kajabi behaviours this depends on: `sort=-created_at` is honoured, so the
walk can stop early; `filter[offer_id]` is **not** — it is accepted and silently
ignored, so rows are filtered in the Worker. Never trust a filter on that API
without proving it narrows the result.

With `STRICT_PURCHASE = "true"` results are released only to an email with a
recorded purchase. A forged `tier` in the request body is refused.

## Storage

KV, keyed by a SHA-256 hash of the email — never the address itself.

| key | holds | life |
|---|---|---|
| `a:<hash>` | the answers, language, completion time | 730 days |
| `p:<hash>` | which offers this email has bought | 730 days |
| `sync:purchases:watermark` | newest purchase already processed | — |

Outcome scores are **computed** from the stored answers on each request, not
stored, so they can always be recomputed or backfilled to Kajabi later.

`/forget` deletes the answers record and deliberately leaves the purchase
record: it is a financial record, and deleting it would permanently lock the
customer out of results they paid for.

## Testing

```
BASE=https://waam-engine.wholisticallyaligned.workers.dev \
HOOK_SECRET=... node test-endpoints.mjs
```

`SKIP_AI=1` skips the slow generation calls. For a real purchase test, use a
100%-off coupon rather than Kajabi's Test Checkout — test mode creates no
purchase record, so nothing reaches the sync.
