// Local end-to-end check of the v2 paywall against `wrangler dev`.
// Usage:  npm run dev          (one terminal)
//         npm run test:local   (another)
//
//   BASE=http://localhost:8787   override host
//   SKIP_AI=1                    skip the two paid calls that spend Anthropic credit
//
// Walks the real flow: submit -> gated -> webhook -> released -> forget.
const BASE   = process.env.BASE || "http://localhost:8787";
const SKIP_AI = process.env.SKIP_AI === "1";
const SECRET = process.env.HOOK_SECRET || "";
const EMAIL  = `waam-test-${Date.now()}@example.com`;

let pass = 0, fail = 0;
const ok = (n, d = "") => { console.log(`  \x1b[32m✓\x1b[0m ${n}${d && "  " + d}`); pass++; };
const no = (n, d = "") => { console.log(`  \x1b[31m✗\x1b[0m ${n}${d && "  " + d}`); fail++; };

const post = (path, body, headers = {}) => fetch(BASE + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

// A representative mid-range profile — every domain answered.
const answers = {};
for (const [d, n] of [["arm",9],["ats",7],["srf",7],["nbm",6],["psb",5],["fwl",7],["ssb",6]])
  for (let i = 1; i <= n; i++) answers[`${d}${i}`] = 2;
Object.assign(answers, { ctx1: "35-44", ctx2: "none", ctx3: "no", ctx4: "6 months", ctx5: "persistent fatigue" });

console.log(`\nWAAM Engine v2 — paywall checks against ${BASE}`);
console.log(`test identity: ${EMAIL}\n`);

// 1. health — storage must be bound, or every write below fails
try {
  const r = await fetch(BASE + "/health");
  const d = await r.json();
  if (d.ok !== true)      no("GET /health", JSON.stringify(d));
  else if (!d.storage)    no("GET /health", "ok but storage:false — KV is not bound, check wrangler.toml");
  else                    ok("GET /health", "ok:true storage:true");
} catch (e) { no("GET /health", e.message + "  — is `npm run dev` running?"); process.exit(1); }

// 2. both pages served
for (const [path, marker, label] of [["/", "WAAM", "EN"], ["/es", "Evaluaci", "ES"]]) {
  const r = await fetch(BASE + path);
  const html = await r.text();
  r.status === 200 && html.includes(marker)
    ? ok(`GET ${path} (${label})`, `${html.length} bytes`)
    : no(`GET ${path} (${label})`, `status ${r.status}`);
}

// 3. validation — no storage writes, no AI spend
for (const [path, body, want, label] of [
  ["/submit",  { email: EMAIL, answers },            400, "consent required"],
  ["/submit",  { consent: true, answers },           400, "missing email"],
  ["/submit",  { consent: true, email: "nope" },     400, "malformed email"],
  ["/results", {},                                   400, "missing email"],
  ["/forget",  {},                                   400, "missing email"],
  ["/nope",    {},                                   404, "unknown endpoint"],
]) {
  const r = await post(path, body);
  r.status === want ? ok(`POST ${path}`, `${want} — ${label}`)
                    : no(`POST ${path}`, `expected ${want}, got ${r.status} — ${label}`);
}

// 4. /hook rejects a bad secret before touching storage
{
  const r = await post("/hook", { email: EMAIL, offer: "results" }, { "X-WAAM-Secret": "wrong" });
  r.status === 401 ? ok("POST /hook", "401 — bad secret rejected")
                   : no("POST /hook", `expected 401, got ${r.status} — webhook is NOT protected`);
}

// 5. submit stores the answers and releases almost nothing
{
  const r = await post("/submit", { email: EMAIL, answers, consent: true, lang: "en" });
  if (r.status !== 200 || !r.data.ok) no("POST /submit", `status ${r.status} ${JSON.stringify(r.data)}`);
  else {
    ok("POST /submit", `200 safetyFlag:${r.data.safetyFlag} completedAt:${r.data.completedAt}`);
    const leaked = ["R", "route", "analysis", "answers"].filter(k => k in r.data);
    leaked.length ? no("  └ paywall", `/submit leaked ${leaked.join(", ")} before payment`)
                  : ok("  └ paywall", "no scores or analysis released pre-payment");
  }
}

// 6. THE PAYWALL — unpaid request must be refused even with a forged tier
{
  const r = await post("/results", { email: EMAIL, tier: "results" });
  r.status === 402 ? ok("POST /results", "402 — forged ?tier=results refused (STRICT_PURCHASE on)")
                   : no("POST /results", `expected 402, got ${r.status} — PAYWALL IS OPEN, check STRICT_PURCHASE`);
}

// 7. webhook records the purchase
if (!SECRET) {
  console.log("  \x1b[33m–\x1b[0m POST /hook   skipped — set HOOK_SECRET to match .dev.vars");
} else {
  const r = await post("/hook", { email: EMAIL, offer: "results" }, { "X-WAAM-Secret": SECRET });
  r.status === 200 && r.data.ok ? ok("POST /hook", "200 — purchase recorded")
                                : no("POST /hook", `status ${r.status} ${JSON.stringify(r.data)}`);

  // 8. results released after purchase (spends Anthropic credit)
  if (SKIP_AI) {
    console.log("  \x1b[33m–\x1b[0m POST /results  skipped — SKIP_AI=1");
  } else {
    const t = Date.now();
    const r2 = await post("/results", { email: EMAIL });
    if (r2.status !== 200) no("POST /results", `expected 200, got ${r2.status} ${JSON.stringify(r2.data)}`);
    else {
      const len = (r2.data.analysis || "").length;
      ok("POST /results", `200 in ${((Date.now()-t)/1000).toFixed(1)}s, analysis ${len} chars`);
      len > 500 ? ok("  └ analysis", "non-empty — model returned prose")
                : no("  └ analysis", `only ${len} chars — check MODEL and content[0] parsing`);
      r2.data.creditActive === true
        ? ok("  └ credit window", `active until ${r2.data.creditExpiresAt}`)
        : no("  └ credit window", `creditActive:${r2.data.creditActive} — expected true just after submit`);
    }
  }
}

// 8b. lead capture — replaces the old no-cors POST, which could not report failure.
// Until KAJABI_API_KEY/SECRET are set the endpoint refuses with 500 before doing
// anything; that is still a real answer, which is the whole point of the change.
{
  const probe = await post("/lead", { email: EMAIL, lang: "en" });
  if (probe.status === 500 && /credentials/i.test(probe.data.error || "")) {
    ok("POST /lead", "500 — credentials not configured (expected until Kajabi keys are set)");
  } else {
    for (const [body, want, label] of [
      [{ lang: "en" },                 400, "missing email"],
      [{ email: "notanemail" },        400, "malformed email"],
    ]) {
      const r = await post("/lead", body);
      r.status === want ? ok("POST /lead", `${want} — ${label}`)
                        : no("POST /lead", `expected ${want}, got ${r.status} — ${label}`);
    }
    if (process.env.LIVE_LEAD === "1") {
      const r = await post("/lead", {
        email: EMAIL, name: "WAAM Test", lang: "en",
        tier: "waam-tier-moderate", track: "waam-track-core", wws: "58",
        domains: "ARM42|ATS55|SRF48|NBM51|PSB44|FWL53|SSB49", type: "baseline",
        purchase_tier: "results",
      });
      r.status === 200 && r.data.ok
        ? ok("POST /lead", `200 — submission ${r.data.formSubmissionId} on form ${r.data.formId}`)
        : no("POST /lead", `status ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    } else {
      console.log("  \x1b[33m–\x1b[0m POST /lead   live submit skipped — set LIVE_LEAD=1 (creates a real Kajabi contact)");
    }
  }
}

// 9. forget
{
  const r = await post("/forget", { email: EMAIL });
  r.status === 200 ? ok("POST /forget", "200") : no("POST /forget", `status ${r.status}`);

  // With a purchase on record the gate is passed and the missing answers show
  // as 404. Without one, STRICT_PURCHASE refuses at 402 before the lookup —
  // correct, and the reason the paywall leaks nothing about which emails exist.
  const r2 = await post("/results", { email: EMAIL, tier: "results" });
  const want = SECRET ? 404 : 402;
  r2.status === want
    ? ok("  └ answers gone", `${want} after forget${SECRET ? "" : " (gated before lookup — no purchase set)"}`)
    : no("  └ answers gone", `expected ${want}, got ${r2.status}`);

  if (SECRET) {
    // Known gap: /forget deletes the a: answers key but leaves the p: purchase
    // record, which stores the email in plaintext for 730 days.
    const r3 = await post("/hook", { email: EMAIL, offer: "results" }, { "X-WAAM-Secret": SECRET });
    r3.status === 200
      ? console.log("  \x1b[33m!\x1b[0m purchase record survives /forget — email retained 730d (known gap)")
      : null;
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
