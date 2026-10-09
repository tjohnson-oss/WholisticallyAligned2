// Local end-to-end check against `wrangler dev` (default http://localhost:8787).
// Usage:  npm run dev          (in one terminal)
//         npm run test:local   (in another)
// Override host:  BASE=http://localhost:8787 node test-endpoints.mjs
// Skip the live Kajabi submit (creates a real contact):  SKIP_LEAD=1
const BASE = process.env.BASE || "http://localhost:8787";
const LEAD_EMAIL = process.env.LEAD_EMAIL || "";

let pass = 0, fail = 0;
const ok = (n, d = "") => { console.log(`  \x1b[32m✓\x1b[0m ${n}${d && "  " + d}`); pass++; };
const no = (n, d = "") => { console.log(`  \x1b[31m✗\x1b[0m ${n}${d && "  " + d}`); fail++; };

const post = (path, body) => fetch(BASE + path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

// A representative mid-range profile — every domain answered.
const answers = {};
for (const [d, n] of [["arm",7],["ats",7],["srf",7],["nbm",6],["psb",5],["fwl",7],["ssb",6]])
  for (let i = 1; i <= n; i++) answers[`${d}${i}`] = 2;
Object.assign(answers, { ctx1: "35-44", ctx2: "none", ctx3: "no", ctx4: "6 months", ctx5: "persistent fatigue" });

console.log(`\nWAAM Engine — local checks against ${BASE}\n`);

// 1. health
try {
  const r = await fetch(BASE + "/health");
  const d = await r.json();
  d.ok === true ? ok("GET /health", "200") : no("GET /health", JSON.stringify(d));
} catch (e) { no("GET /health", e.message + "  — is `npm run dev` running?"); process.exit(1); }

// 2. both pages served, with the right language and CSP
for (const [path, marker, label] of [["/", "WAAM", "EN"], ["/es", "Evaluaci", "ES"]]) {
  const r = await fetch(BASE + path);
  const html = await r.text();
  const csp = r.headers.get("content-security-policy") || "";
  r.status === 200 && html.includes(marker)
    ? ok(`GET ${path} (${label})`, `${html.length} bytes, CSP: ${csp.slice(0, 40) || "none"}`)
    : no(`GET ${path} (${label})`, `status ${r.status}`);
}

// 3. validation paths — no AI spend, no side effects
for (const [path, body, want, label] of [
  ["/assess", {}, 400, "missing answers"],
  ["/goals", {}, 400, "missing pct"],
  ["/nd", {}, 400, "missing nd"],
  ["/lead", { name: "x" }, 400, "missing email"],
  ["/lead", { email: "notanemail" }, 400, "malformed email"],
  ["/nope", {}, 404, "unknown endpoint"],
]) {
  const { status, data } = await post(path, body);
  if (status === 500 && /not configured/i.test(data.error || "")) {
    console.log(`  \x1b[33m—\x1b[0m POST ${path}  ${label}: skipped — ${data.error}`);
    continue;
  }
  status === want ? ok(`POST ${path} → ${want}`, `${label}: ${data.error || ""}`)
                  : no(`POST ${path}`, `${label}: expected ${want}, got ${status} ${JSON.stringify(data).slice(0,90)}`);
}

// 4. /assess — the real thing (costs a few cents, ~60s)
console.log("\n  …/assess  (real AI call, ~60s)");
let R = null;
{
  const t = Date.now();
  const { status, data } = await post("/assess", { answers, lang: "en" });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  if (status !== 200) no("POST /assess", `${status} ${JSON.stringify(data).slice(0,120)}`);
  else {
    R = data.R;
    const heads = [...(data.analysis || "").matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());
    heads.length >= 6 ? ok("POST /assess", `${secs}s · ${heads.length}/6 sections · WWS ${data.R?.wws}`)
                      : no("POST /assess", `${secs}s · only ${heads.length}/6 sections — max_tokens too low?`);
    data.route?.primary?.name ? ok("  routing present", data.route.primary.name) : no("  routing missing");
  }
}

// 5. /goals — the JSON.parse path
if (R) {
  console.log("\n  …/goals  (real AI call, ~30s)");
  const t = Date.now();
  const { status, data } = await post("/goals", { pct: R.pct, ctx: { age: "35-44" }, lang: "en" });
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  status === 200 && Array.isArray(data.goals) && data.goals.length === 5
    ? ok("POST /goals", `${secs}s · ${data.goals.length} goals · ${data.goals.map(g => g.domain).join(", ")}`)
    : no("POST /goals", `${secs}s · ${status} ${JSON.stringify(data).slice(0,140)}`);
}

// 6. /lead — real Kajabi submit, only with an explicit address
if (!LEAD_EMAIL) {
  console.log("\n  \x1b[33m—\x1b[0m POST /lead live submit skipped (set LEAD_EMAIL=you@example.com to run it)");
} else {
  console.log("\n  …/lead  (creates a REAL Kajabi contact)");
  for (const lang of ["en", "es"]) {
    const { status, data } = await post("/lead", { name: `WAAM ${lang.toUpperCase()} test`, email: LEAD_EMAIL, lang });
    status === 200 && data.ok
      ? ok(`POST /lead (${lang})`, `form ${data.formId} · submission ${data.formSubmissionId}`)
      : no(`POST /lead (${lang})`, `${status} ${JSON.stringify(data).slice(0,160)}`);
  }
}

console.log(`\n${fail === 0 ? "\x1b[32mall passed\x1b[0m" : "\x1b[31m" + fail + " failed\x1b[0m"}  (${pass} passed)\n`);
process.exit(fail ? 1 : 0);
