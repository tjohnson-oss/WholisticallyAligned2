/**
 * WAAM™ Engine — Cloudflare Worker (production)
 * Wholistically Aligned LLC — CONFIDENTIAL
 * ---------------------------------------------------------------------------
 * Holds ALL proprietary logic server-side: WAAM Index™ weights, cross-domain
 * amplifiers, tier thresholds, foundation-first routing, and every Clinical
 * Engine™ prompt. The browser sends raw answers and receives only results —
 * nothing in the client page reveals the scoring model or prompt architecture.
 * This is the remediation recorded in IDF v2.2 (Section 10 / §102 caution).
 *
 * DEPLOY (one time):
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler secret put ANTHROPIC_API_KEY     ← paste your sk-ant-... key
 *   wrangler deploy
 * Then set ALLOWED_ORIGINS in wrangler.toml to your Kajabi domain(s) and
 * paste the deployed URL into WORKER_URL in the production HTML.
 *
 * Pages (GET): /  → English assessment   /es → Spanish assessment
 *
 * Endpoints (POST, JSON):
 *   /submit   free  — stores answers by email, returns ONLY the safety flag
 *   /results  paid  — retrieves by email, scores, generates the analysis
 *   /hook     Kajabi purchase webhook (X-WAAM-Secret header)
 *   /goals    paid  — S.M.A.R.T. goal generation
 *   /nd       paid  — Neurodivergence Insights interpretation
 *   /forget   deletion request
 *   Embedded in Kajabi through an iframe (see kajabi_embed_*.html). Only
 *   origins listed in ALLOWED_ORIGINS may frame them.
 *
 * Endpoints (all POST, JSON):
 *   /assess  {answers}                      → {R, route, analysis}
 *   /goals   {pct, ctx}                     → {goals:[{domain,goal,S,M,A,R,T}×5]}
 *   /nd      {nd:{NDA,NDS,MASK,CHILD}, pct, wws} → {analysis}
 */

import PAGE_EN from "./waam_assessment_production.html";
import PAGE_ES from "./waam_assessment_production_es.html";

const MODEL = "claude-sonnet-4-6";

// ── Kajabi Public API (lead capture) ────────────────────────────────────────
// Credentials come from Kajabi > Settings > Public API (NOT Account Details).
const KAJABI_API_BASE = "https://api.kajabi.com/v1";
const KAJABI_FORM_IDS = {
  en: "2149686351", // "Assessment Form - English"
  es: "2149686352", // "Assessment Form - Spanish"
};

// The public site that renders the forms. Lead capture posts here rather than
// to the Public API: api.kajabi.com/forms/{id}/submit accepts custom-field
// attributes and silently discards them, so the outcome dataset never arrived.
// This endpoint is what the form's own embed posts to, and it does store them.
const KAJABI_SITE_BASE = "https://www.wholisticallyaligned.com";

// Kajabi assigns its own handles; these were confirmed against /custom_fields
// and the live form markup on both languages. The titles are the client-facing
// names, the handles are what the form actually accepts.
const KAJABI_FIELD_HANDLES = {
  tier:          "custom_4",  // waam_tier
  track:         "custom_5",  // waam_track
  wws:           "custom_6",  // waam_wws
  lang:          "custom_7",  // waam_language
  domains:       "custom_8",  // waam_domains
  type:          "custom_9",  // waam_type
  purchase_tier: "custom_10", // waam_purchase_tier
};

// ── Purchase sync ───────────────────────────────────────────────────────────
// Kajabi's "default notification" is an admin email, not an outbound webhook,
// so a completed purchase never reaches /hook on its own. Rather than depend on
// a webhook somebody has to configure — and that silently loses a paying
// customer if it ever fails — the Worker polls Kajabi on a cron and records
// purchases itself. /hook still works and stays the fastest path once wired.
const WAAM_OFFERS = {
  "2151443344": "results",        // kcuTVJPo - WAAM Results Unlock ($49 one-time)
  "2151443421": "enroll",         // E6k3ytnz - Enrollment Offer ($149.99 setup, then $79.99/month)
  "2151443422": "enroll_prepaid", // ZSCG2c6G - Enrollment Full Payment ($499.99, then $79.99/month after 6 months)
};
const SYNC_WATERMARK_KEY = "sync:purchases:watermark";

// ── WAAM Clinical Engine™: proprietary weighted scoring (server-side) ──
function pillScore(answers, qid, options, map) {
  const v = answers[qid];
  if (typeof v === "number" && Number.isFinite(v)) {
    const i = Math.min(map.length - 1, Math.max(0, Math.round(v)));
    return map[i];
  }
  const i = options.indexOf(v);
  return i >= 0 ? map[i] : map[Math.floor(map.length / 2)];
}

function computeWAAM(answers, lang) {
  const P = (qid, options, map) => pillScore(answers, qid, options, map);
  const d = {};
  d.ARM = ["arm1","arm2","arm3","arm4","arm5","arm6","arm7","arm8","arm9"].reduce((s,k)=>s+(Number(answers[k])||0),0);
  d.ATS = ["ats1","ats2","ats3","ats4","ats5","ats6","ats7"].reduce((s,k)=>s+(Number(answers[k])||0),0);
  d.SRF =
    P("srf1",["Less than 5h","5–6 hours","6–7 hours","7–8 hours","More than 8h"],[3,2,1,0,2]) +
    P("srf2",["Under 15 min","15–30 min","30–60 min","Over 60 min"],[0,1,2,3]) +
    P("srf3",["Not at all","Less than once/week","1–2 times/week","3+ times/week"],[0,1,2,3]) +
    (4-(Number(answers["srf4"])||2))*0.75 +
    P("srf5",["Never","Less than once/week","1–2 times/week","3+ times/week"],[0,1,2,3]) +
    P("srf6",["Never","Rarely","Sometimes","Often","Almost always"],[0,0,1,2,3]);
  d.NBM =
    P("nbm1",["0–1 servings","2–3 servings","4–5 servings","6+ servings"],[3,2,1,0]) +
    P("nbm2",["Rarely / never","1–2 times/week","3–5 times/week","Daily","Multiple times daily"],[0,1,2,3,4]) +
    P("nbm3",["Rarely","Sometimes","Most meals","Almost always"],[3,2,1,0]) +
    P("nbm4",["Very diminished","Somewhat reduced","Well matched","Somewhat elevated","Strongly elevated or compulsive"],[2,1,0,1,3]) +
    P("nbm5",["Never","Rarely","1–2 times/week","Most days"],[0,1,2,3]);
  d.PSB =
    P("psb1",["0 days","1–2 days","3–4 days","5–6 days","Every day"],[4,3,2,1,0]) +
    P("psb2",["I don't currently exercise","Under 20 min","20–30 min","30–60 min","Over 60 min"],[4,3,2,1,0]) +
    P("psb4",["Under 4 hours","4–6 hours","6–8 hours","8–10 hours","Over 10 hours"],[0,1,2,3,4]);
  const fwlPos=["fwl1","fwl2","fwl3","fwl4","fwl5","fwl7"].reduce((s,k)=>s+(Number(answers[k])||0),0);
  d.FWL=(24-fwlPos)+(Number(answers["fwl6"])||0);
  d.SSB=["ssb1","ssb2","ssb3","ssb4","ssb5","ssb6","ssb7","ssb8"].reduce((s,k)=>s+(Number(answers[k])||0),0);

  const MAX={ARM:27,ATS:21,SRF:18,NBM:16,PSB:12,FWL:28,SSB:16};
  const W={ARM:1.4,ATS:1.3,SRF:1.2,NBM:1.0,PSB:1.0,FWL:1.1,SSB:1.1};
  const pct={};Object.keys(MAX).forEach(k=>pct[k]=Math.min(100,Math.round((d[k]/MAX[k])*100)));

  let wSum=0,wTot=0;
  Object.keys(W).forEach(k=>{wSum+=pct[k]*W[k];wTot+=W[k]});
  let burden=wSum/wTot;
  const amps=[];
  if(pct.ARM>60&&pct.SRF>60){burden*=1.08;amps.push("Mood–Sleep interaction (+8%)")}
  if(pct.ARM>60&&pct.ATS>60){burden*=1.06;amps.push("Mood–Anxiety comorbidity (+6%)")}
  if(pct.ATS>60&&pct.SRF>60){burden*=1.05;amps.push("Anxiety–Sleep interaction (+5%)")}
  if(pct.ARM>70&&pct.ATS>70&&pct.SRF>70){burden*=1.06;amps.push("Triple-domain elevation (+6%)")}
  burden=Math.min(100,burden);

  const wws=Math.max(0,Math.round(100-burden));
  const tiers = {
    en: ["Flourishing","Functional Wellness","Emerging Distress","Significant Impairment","Acute Clinical Need"],
    es: ["Florecimiento","Bienestar Funcional","Malestar Emergente","Deterioro Significativo","Necesidad Clínica Aguda"],
  };
  const idx = wws>=80?0:wws>=65?1:wws>=50?2:wws>=35?3:4;
  const keys = ["flourishing","functional-wellness","emerging-distress","significant-impairment","acute-clinical-need"];
  const colors = [["#2E7D52","#E8F5EE"],["#4DB6AC","#E0F2F1"],["#9A6B0A","#FEF8E8"],["#C0573B","#FDEEE9"],["#8B1C1C","#FCE8E8"]];
  const L = tiers[lang] ? lang : "en";
  const tier = { key: keys[idx], name: tiers[L][idx], color: colors[idx][0], bg: colors[idx][1] };

  return {pct,wws,tier,amps,siFlag:(Number(answers["arm9"])||0)>0};
}

// ── Foundation-first routing engine (server-side) ──
function routeWAAM(R, lang){
  if (lang === "es") return routeWAAM_es(R);
  const p=R.pct, EL=60;
  // Only two programs exist today: Foundations of MBSR (six months) and the
  // Mindful Eating series. "primary" is therefore an EMPHASIS within the
  // foundation, not a separate product to buy. Mindful Eating is the one
  // add-on, included in the monthly fee when the nutrition domain is elevated.
  let primary;
  if(p.ARM>=EL&&p.ATS>=EL)      primary={key:"emphasis-mood-anxiety",icon:"\u{1F9ED}",name:"Mood & Anxiety Emphasis",why:"Both your mood and anxiety domains are elevated, so your foundation leads with the emotion-regulation and nervous-system practices \u2014 breath anchoring, body scan, and working with difficult thoughts \u2014 and returns to them throughout."};
  else if(p.ARM>=EL)            primary={key:"emphasis-mood",icon:"\u2601\uFE0F",name:"Mood Emphasis",why:"Your mood domain carries the highest burden, so your foundation front-loads mindful behavioral activation \u2014 small, deliberate re-engagement with what once brought energy \u2014 alongside self-compassion practice."};
  else if(p.ATS>=EL)            primary={key:"emphasis-anxiety",icon:"\u{1F300}",name:"Anxiety Emphasis",why:"Your anxiety domain is elevated, so your foundation leads with worry-decentering and nervous-system regulation \u2014 learning to notice a worry without following it."};
  else if(p.SSB>=EL)            primary={key:"emphasis-body",icon:"\u{1FAC0}",name:"Body & Somatic Emphasis",why:"Your body is carrying significant stress expression, so your foundation emphasizes body scan and somatic awareness from the first weeks."};
  else if(p.FWL>=EL)            primary={key:"emphasis-meaning",icon:"\u2728",name:"Meaning & Connection Emphasis",why:"Your life-satisfaction domain is elevated, so your foundation leans into loving-kindness and values practices that rebuild meaning and connection."};
  else if(p.SRF>=EL)            primary={key:"emphasis-sleep",icon:"\u{1F319}",name:"Sleep Emphasis",why:"Sleep carries your highest burden, so your foundation sequences its restorative practices \u2014 body scan and wind-down routines \u2014 to prioritize your sleep first."};
  else                          primary={key:"balanced",icon:"\u{1F331}",name:"Balanced Path",why:"No single domain stands out, so your foundation follows the full arc at an even pace \u2014 the best way to build the skills before you need them."};

  // The one real add-on, included in the monthly fee.
  const secondary=(p.NBM>=EL)?{key:"mindful-eating",icon:"\u{1F33F}",name:"Mindful Eating Series",why:"Your nutrition domain is elevated, so this eight-week series is included in your program \u2014 it works on your relationship with food, hunger, and nourishment alongside the foundation."}:null;

  const w=R.wws;
  const foundation=
    w>=80?{mode:"optional",label:"Optional Enrichment",desc:"Foundations of MBSR is optional at your wellness level \u2014 but recommended as the base that deepens every other practice, across six months."}
    :w>=50?{mode:"sequential",label:"Start Here \u2014 Your Foundation",desc:"Your six-month Foundations of MBSR begins with the MBSR Core phase and builds through the Integration Bridge \u2014 one continuous journey, with early gains typically emerging in weeks 4\u20136."}
    :w>=35?{mode:"parallel",label:"Foundation With Added Support",desc:"Your six-month Foundations of MBSR starts right away, with the practices most relevant to your scores brought forward into the earliest weeks rather than held until later."}
    :{mode:"parallel-care",label:"Foundation + Professional Care",desc:"Your six-month Foundations of MBSR starts right away, with the most relevant practices brought forward. At your current burden level, we also warmly encourage connecting with a licensed professional \u2014 the program works best as a complement to care."};

  return {primary,secondary,foundation};
}


function routeWAAM_es(R){
  const p=R.pct, EL=60;
  let primary;
  if(p.ARM>=EL&&p.ATS>=EL)      primary={key:"emphasis-mood-anxiety",icon:"\u{1F9ED}",name:"\u00c9nfasis en \u00c1nimo y Ansiedad",why:"Tanto su dominio de \u00e1nimo como el de ansiedad est\u00e1n elevados, por lo que su fundamento comienza con las pr\u00e1cticas de regulaci\u00f3n emocional y del sistema nervioso \u2014 anclaje en la respiraci\u00f3n, escaneo corporal y el trabajo con pensamientos dif\u00edciles \u2014 y vuelve a ellas a lo largo del recorrido."};
  else if(p.ARM>=EL)            primary={key:"emphasis-mood",icon:"\u2601\uFE0F",name:"\u00c9nfasis en el \u00c1nimo",why:"Su dominio de \u00e1nimo carga el mayor peso, por lo que su fundamento adelanta la activaci\u00f3n conductual consciente \u2014 peque\u00f1os reencuentros deliberados con lo que antes le daba energ\u00eda \u2014 junto con la pr\u00e1ctica de autocompasi\u00f3n."};
  else if(p.ATS>=EL)            primary={key:"emphasis-anxiety",icon:"\u{1F300}",name:"\u00c9nfasis en la Ansiedad",why:"Su dominio de ansiedad est\u00e1 elevado, por lo que su fundamento comienza con el descentramiento de la preocupaci\u00f3n y la regulaci\u00f3n del sistema nervioso \u2014 aprender a notar una preocupaci\u00f3n sin seguirla."};
  else if(p.SSB>=EL)            primary={key:"emphasis-body",icon:"\u{1FAC0}",name:"\u00c9nfasis Corporal y Som\u00e1tico",why:"Su cuerpo carga una expresi\u00f3n significativa del estr\u00e9s, por lo que su fundamento enfatiza el escaneo corporal y la conciencia som\u00e1tica desde las primeras semanas."};
  else if(p.FWL>=EL)            primary={key:"emphasis-meaning",icon:"\u2728",name:"\u00c9nfasis en Sentido y Conexi\u00f3n",why:"Su dominio de satisfacci\u00f3n vital est\u00e1 elevado, por lo que su fundamento se apoya en las pr\u00e1cticas de bondad amorosa y valores que reconstruyen el sentido y la conexi\u00f3n."};
  else if(p.SRF>=EL)            primary={key:"emphasis-sleep",icon:"\u{1F319}",name:"\u00c9nfasis en el Sue\u00f1o",why:"El sue\u00f1o carga su mayor peso, por lo que su fundamento secuencia sus pr\u00e1cticas restaurativas \u2014 escaneo corporal y rutinas de descanso \u2014 para priorizar su sue\u00f1o primero."};
  else                          primary={key:"balanced",icon:"\u{1F331}",name:"Ruta Equilibrada",why:"Ning\u00fan dominio se destaca, por lo que su fundamento sigue el arco completo a un ritmo parejo \u2014 la mejor manera de construir las habilidades antes de necesitarlas."};

  const secondary=(p.NBM>=EL)?{key:"mindful-eating",icon:"\u{1F33F}",name:"Serie de Alimentaci\u00f3n Consciente",why:"Su dominio de nutrici\u00f3n est\u00e1 elevado, por lo que esta serie de ocho semanas viene incluida en su programa \u2014 trabaja su relaci\u00f3n con la comida, el hambre y el nutrirse, junto al fundamento."}:null;

  const w=R.wws;
  const foundation=
    w>=80?{mode:"optional",label:"Enriquecimiento Opcional",desc:"Fundamentos de MBSR es opcional en su nivel de bienestar \u2014 pero se recomienda como la base que profundiza toda otra pr\u00e1ctica, a lo largo de seis meses."}
    :w>=50?{mode:"sequential",label:"Comience Aqu\u00ed \u2014 Su Fundamento",desc:"Sus Fundamentos de MBSR de seis meses comienzan con la fase del N\u00facleo MBSR y avanzan por el Puente de Integraci\u00f3n \u2014 un recorrido continuo, con avances tempranos que suelen surgir en las semanas 4\u20136."}
    :w>=35?{mode:"parallel",label:"Fundamento con Apoyo Adicional",desc:"Sus Fundamentos de MBSR de seis meses comienzan de inmediato, adelantando a las primeras semanas las pr\u00e1cticas m\u00e1s relevantes para sus puntajes en lugar de reservarlas para despu\u00e9s."}
    :{mode:"parallel-care",label:"Fundamento + Atenci\u00f3n Profesional",desc:"Sus Fundamentos de MBSR de seis meses comienzan de inmediato, adelantando las pr\u00e1cticas m\u00e1s relevantes. En su nivel actual de carga, tambi\u00e9n le animamos c\u00e1lidamente a conectar con un profesional licenciado \u2014 el programa funciona mejor como complemento de la atenci\u00f3n."};

  return {primary,secondary,foundation};
}

function ndBand(p,lang){if(lang==="es")return p<30?"Alineaci\u00f3n baja":p<50?"Patr\u00f3n emergente":p<70?"Patr\u00f3n notable":"Patr\u00f3n fuerte";return p<30?"Low alignment":p<50?"Emerging pattern":p<70?"Notable pattern":"Strong pattern"}

// ── Clinical Engine™ prompts (server-side; never sent to the browser) ──
function analysisPrompt(R, route, ctx, lang){
  if (lang === "es") return analysisPrompt_es(R, route, ctx);
  return `You are the WAAM Clinical Engine™, the analysis layer of the Wholistically Aligned Assessment Method™ — a proprietary whole-person wellness assessment developed under the clinical direction of a board-certified psychiatric provider. You provide psychoeducational analysis, never diagnosis.

WAAM™ DOMAIN BURDEN SCORES (0–100%, higher = greater burden):
- WAAM-ARM™ Affective Regulation & Mood: ${R.pct.ARM}%
- WAAM-ATS™ Anxiety & Threat Sensitivity: ${R.pct.ATS}%
- WAAM-SRF™ Sleep Architecture & Restorative Function: ${R.pct.SRF}%
- WAAM-NBM™ Nutritional Behavior & Metabolic Wellbeing: ${R.pct.NBM}%
- WAAM-PSB™ Physical Activation & Sedentary Burden: ${R.pct.PSB}%
- WAAM-FWL™ Functional Wellbeing & Life Satisfaction: ${R.pct.FWL}%
- WAAM-SSB™ Somatic Symptom Expression & Body Burden: ${R.pct.SSB}%
WHOLE WELLNESS SCORE™: ${R.wws}/100 — Tier: ${R.tier.name}
Cross-domain amplifiers detected: ${R.amps.length?R.amps.join("; "):"none"}
${R.siFlag?"SAFETY NOTE: Endorsed thoughts of self-harm. Weave crisis resources (988) gently but clearly into the analysis and prioritize safety.":""}

ROUTING ENGINE OUTPUT (your Therapeutic Pathway narrative MUST align with this — same foundation mode, same matched program):
- Foundation mode: ${route.foundation.mode} — ${route.foundation.label}
- Matched track: ${route.primary.name}
${route.secondary?"- Secondary: "+route.secondary.name:""}

PERSONAL CONTEXT:
- Age range: ${ctx.age||"not specified"}
- Prior diagnosis: ${ctx.dx||"not specified"}
- Currently in therapy: ${ctx.therapy||"not specified"}
- Symptom duration: ${ctx.duration||"not specified"}
- Stated concern: ${ctx.concern||"none provided"}

PROGRAM CONTEXT: The foundational offering is a SIX-MONTH MBSR-informed wellness program. Whenever you reference timelines, trajectory, or expectations, frame improvement as a gradual six-month journey — meaningful early gains typically emerge in weeks 4–6, with deeper consolidation across months 2–6. Never describe the foundational program as an 8-week or 12-week course.

Generate a warm, clinically-informed WAAM™ analysis with these exact sections:

## YOUR WELLNESS PICTURE
2–3 compassionate sentences describing the overall presentation and how the elevated domains interconnect. Use psychoeducational language ("a pattern consistent with...") — never diagnostic labels applied to the person.

## PRESENTATIONS TO EXPLORE WITH A CLINICIAN
2–4 clinical presentations a professional might evaluate, framed educationally.

## YOUR THERAPEUTIC PATHWAY
Apply Wholistically Aligned's foundation-first model. ALWAYS begin with the foundation recommendation calibrated to their WWS™ tier:
- Flourishing (80–100): the six-month Foundational MBSR-Informed Wellness Program is optional but recommended as an enrichment foundation.
- Functional Wellness (65–79) or Emerging Distress (50–64): complete the MBSR Core phase first, then the Integration Bridge transitions them into their matched track below — one continuous six-month journey.
- Significant Impairment (35–49): a condensed MBSR Core runs IN PARALLEL with their matched track — they should not wait months for individualized support.
- Acute Clinical Need (0–34): MBSR Core in parallel with their matched track, PLUS a clear, warm encouragement to also engage professional care now.

Then name their matched track(s) using this exact routing logic against their domain burdens (≥60% = elevated):
IMPORTANT — only two programs exist. Do NOT invent, name, or promise any other course (no DBT, CBT, ACT, interpersonal, or trauma-focused series, and no "coming soon" programs):
1. Foundations of MBSR — the six-month foundational program, included in enrollment.
2. Mindful Eating Series — an eight-week series included in the monthly fee when the nutrition domain is elevated.
Describe their matched path as an EMPHASIS WITHIN Foundations of MBSR, using the emphasis named in the routing output above — not as a separate program to buy:
- ARM and ATS both elevated → Mood & Anxiety Emphasis (emotion regulation and nervous-system practices brought forward)
- ARM elevated alone → Mood Emphasis (mindful behavioral activation, self-compassion)
- ATS elevated alone → Anxiety Emphasis (worry decentering, nervous-system regulation)
- SSB elevated → Body & Somatic Emphasis (body scan, somatic awareness)
- FWL elevated → Meaning & Connection Emphasis (loving-kindness, values practices)
- SRF elevated → Sleep Emphasis (restorative practices sequenced first)
- No domain ≥60% → Balanced Path (full arc at an even pace)
If NBM is elevated, also mention the Mindful Eating Series as included alongside the foundation.
Name the specific Wholistically Aligned program(s), explain in one sentence each why that program fits their exact score pattern, and describe the foundation→track sequence as one coherent journey.

## NATURAL SUPPORTS WITH RESEARCH EVIDENCE
4–6 evidence-supported supplements relevant to the elevated domains. For each: name and form, what research shows (brief), and key cautions/interactions to verify with a provider.

## ALIGNED LIFESTYLE SHIFTS
4–6 specific, actionable changes targeting the highest-burden domains. Practical, not generic.

## YOUR NEXT 7 DAYS
2–3 sentences of genuine encouragement, then 3 concrete steps for this week.

Be warm, specific, and direct. No closing disclaimer.`;
}

function goalsPrompt(pct, ctx, lang){
  if (lang === "es") return goalsPrompt_es(pct, ctx);
  return `You are the goal-generation module of the WAAM Clinical Engine™. Based on this WAAM™ wellness profile, generate exactly 5 S.M.A.R.T. goals — one for each life area: Mood, Sleep, Movement, Nutrition, Relationships.

DOMAIN BURDEN (0-100%, higher = greater burden):
Mood ${pct.ARM}% | Anxiety ${pct.ATS}% | Sleep ${pct.SRF}% | Nutrition ${pct.NBM}% | Movement ${pct.PSB}% | Life Satisfaction ${pct.FWL}% | Somatic ${pct.SSB}%
User context: age ${ctx.age||"unspecified"}, symptom duration ${ctx.duration||"unspecified"}, concern: ${ctx.concern||"none"}

Calibrate ambition to burden level — high-burden domains get gentle, highly achievable starter goals; low-burden domains get growth goals. Goals must be concrete behaviors, not outcomes ("walk 10 minutes after lunch" not "feel happier").

Respond with ONLY a JSON array, no markdown fences, no preamble:
[{"domain":"Mood","goal":"<one-sentence goal statement>","S":"<what specifically>","M":"<how it's measured>","A":"<why it's achievable for this person>","R":"<why it's relevant to their profile>","T":"<timeframe — an early milestone within the six-month foundational program, e.g. \\"Within 4 weeks\\" or \\"By the end of month 2\\">"}, ...]`;
}

function ndPrompt(nd, pct, wws, lang){
  if (lang === "es") return ndPrompt_es(nd, pct, wws);
  return `You are the Neurodivergence Insights™ module of the WAAM Clinical Engine™. You provide neurodivergence-affirming psychoeducation — traits framed as differences with strengths and costs, never deficits or disorders to fix. Never diagnose. RESPOND WARMLY AND SPECIFICALLY.

TRAIT INDICES (0–100% alignment):
- WAAM-NDA™ Attention/Executive/Impulsivity: ${nd.NDA}% — ${ndBand(nd.NDA)}
- WAAM-NDS™ Social-Sensory/Autistic traits: ${nd.NDS}% — ${ndBand(nd.NDS)}
- Masking Index: ${nd.MASK}%
- Childhood-onset indicators: ${nd.CHILD?"present":"limited"}
CORE WAAM™ BURDEN (for context): Mood ${pct.ARM??"n/a"}% | Anxiety ${pct.ATS??"n/a"}% | Sleep ${pct.SRF??"n/a"}% | WWS™ ${wws??"n/a"}

Interpretation rules: If masking ≥60 with NDS 30–69, note trait screens may UNDERestimate masked presentations (especially common in women and those identified late). If NDA ≥50 without childhood indicators, gently note that formal attention-difference identification requires childhood onset, so exploring early history with a clinician matters. If core burden (anxiety/mood/sleep) is elevated alongside notable-or-strong traits, explain the downstream hypothesis: chronic effort of compensating for unrecognized traits can generate anxiety, exhaustion, and sleep disruption — and support that addresses the traits often relieves the burden. If both indices are low-alignment, say so plainly and validate that their core WAAM™ results remain the main story.

Generate exactly these sections (keep total under 350 words):
## WHAT YOUR PATTERN SUGGESTS
## HOW IT MAY CONNECT TO YOUR CORE SCORES
## A REAL ANSWER IS AVAILABLE
Final section: 2–3 sentences on what a formal evaluation with a psychiatric provider involves and clarifies. No pricing. No closing disclaimer.`;
}


// ── Spanish (usted) prompt variants ──
function analysisPrompt_es(R, route, ctx){
  return `Eres el WAAM Clinical Engine\u2122, la capa de an\u00e1lisis del Wholistically Aligned Assessment Method\u2122 \u2014 una evaluaci\u00f3n propietaria de bienestar integral desarrollada bajo la direcci\u00f3n cl\u00ednica de una proveedora psiqui\u00e1trica certificada. Proporcionas an\u00e1lisis psicoeducativo, nunca diagn\u00f3stico. Escribe TODO en espa\u00f1ol y dir\u00edgete a la persona siempre de usted (registro formal), nunca de t\u00fa.

PUNTAJES DE CARGA POR DOMINIO WAAM\u2122 (0\u2013100%, mayor = mayor carga):
- WAAM-ARM\u2122 Regulaci\u00f3n Afectiva y \u00c1nimo: ${R.pct.ARM}%
- WAAM-ATS\u2122 Ansiedad y Sensibilidad a la Amenaza: ${R.pct.ATS}%
- WAAM-SRF\u2122 Arquitectura del Sue\u00f1o y Funci\u00f3n Restaurativa: ${R.pct.SRF}%
- WAAM-NBM\u2122 Conducta Nutricional y Bienestar Metab\u00f3lico: ${R.pct.NBM}%
- WAAM-PSB\u2122 Activaci\u00f3n F\u00edsica y Carga Sedentaria: ${R.pct.PSB}%
- WAAM-FWL\u2122 Bienestar Funcional y Satisfacci\u00f3n Vital: ${R.pct.FWL}%
- WAAM-SSB\u2122 Expresi\u00f3n Som\u00e1tica y Carga Corporal: ${R.pct.SSB}%
PUNTAJE DE BIENESTAR INTEGRAL\u2122 (WWS\u2122): ${R.wws}/100 \u2014 Nivel: ${R.tier.name}
Amplificadores entre dominios detectados: ${R.amps.length?R.amps.join("; "):"ninguno"}
${R.siFlag?"NOTA DE SEGURIDAD: Report\u00f3 pensamientos de autolesi\u00f3n. Integra recursos de crisis (988) con delicadeza pero con claridad, y prioriza la seguridad.":""}

SALIDA DEL MOTOR DE RUTAS (su narrativa de Ruta Terap\u00e9utica DEBE alinearse con esto \u2014 mismo modo de fundamento, mismo programa asignado):
- Modo de fundamento: ${route.foundation.mode} \u2014 ${route.foundation.label}
- Ruta asignada: ${route.primary.name}
${route.secondary?"- Secundaria: "+route.secondary.name:""}

CONTEXTO PERSONAL:
- Rango de edad: ${ctx.age||"no especificado"}
- Diagn\u00f3stico previo: ${ctx.dx||"no especificado"}
- Actualmente en terapia: ${ctx.therapy||"no especificado"}
- Duraci\u00f3n de los patrones: ${ctx.duration||"no especificada"}
- Preocupaci\u00f3n expresada: ${ctx.concern||"ninguna"}

CONTEXTO DEL PROGRAMA: La oferta fundacional es un programa de bienestar informado por MBSR de SEIS MESES. Siempre que menciones plazos, trayectoria o expectativas, presenta la mejor\u00eda como un recorrido gradual de seis meses \u2014 los primeros avances significativos suelen surgir en las semanas 4\u20136, con una consolidaci\u00f3n m\u00e1s profunda entre los meses 2 y 6. Nunca describas el programa fundacional como un curso de 8 o 12 semanas.

Genera un an\u00e1lisis WAAM\u2122 c\u00e1lido e informado cl\u00ednicamente con exactamente estas secciones:

## SU PANORAMA DE BIENESTAR
2\u20133 oraciones compasivas que describan la presentaci\u00f3n general y c\u00f3mo se interconectan los dominios elevados. Lenguaje psicoeducativo ("un patr\u00f3n consistente con...") \u2014 nunca etiquetas diagn\u00f3sticas aplicadas a la persona.

## PRESENTACIONES PARA EXPLORAR CON UN CL\u00cdNICO
2\u20134 presentaciones cl\u00ednicas que un profesional podr\u00eda evaluar, planteadas educativamente.

## SU RUTA TERAP\u00c9UTICA
Aplica el modelo fundamento-primero de Wholistically Aligned. SIEMPRE comienza con la recomendaci\u00f3n de fundamento calibrada a su nivel WWS\u2122:
- Florecimiento (80\u2013100): el Programa Fundacional de Bienestar Informado por MBSR de seis meses es opcional pero recomendado como fundamento de enriquecimiento.
- Bienestar Funcional (65\u201379) o Malestar Emergente (50\u201364): completar primero la fase del N\u00facleo MBSR; luego el Puente de Integraci\u00f3n le lleva a su ruta asignada \u2014 un recorrido continuo de seis meses.
- Deterioro Significativo (35\u201349): Fundamentos de MBSR comienza de inmediato, adelantando a las primeras semanas las pr\u00e1cticas m\u00e1s relevantes \u2014 no debe esperar meses para el apoyo m\u00e1s pertinente.
- Necesidad Cl\u00ednica Aguda (0\u201334): lo mismo, M\u00c1S un aliento claro y c\u00e1lido a buscar tambi\u00e9n atenci\u00f3n profesional ahora.

IMPORTANTE \u2014 solo existen dos programas. NO inventes, nombres ni prometas ning\u00fan otro curso (nada de DBT, TCC, ACT, series interpersonales o centradas en trauma, ni programas "pr\u00f3ximamente"):
1. Fundamentos de MBSR \u2014 el programa fundacional de seis meses, incluido en la inscripci\u00f3n.
2. Serie de Alimentaci\u00f3n Consciente \u2014 una serie de ocho semanas incluida en la mensualidad cuando el dominio de nutrici\u00f3n est\u00e1 elevado.
Describe su ruta asignada como un \u00c9NFASIS DENTRO de Fundamentos de MBSR, usando el \u00e9nfasis indicado arriba en la salida del motor de rutas \u2014 nunca como un programa aparte que deba comprar (\u226560% = elevado):
- ARM y ATS ambos elevados \u2192 \u00c9nfasis en \u00c1nimo y Ansiedad (pr\u00e1cticas de regulaci\u00f3n emocional y del sistema nervioso adelantadas)
- Solo ARM elevado \u2192 \u00c9nfasis en el \u00c1nimo (activaci\u00f3n conductual consciente, autocompasi\u00f3n)
- Solo ATS elevado \u2192 \u00c9nfasis en la Ansiedad (descentramiento de la preocupaci\u00f3n, regulaci\u00f3n del sistema nervioso)
- SSB elevado \u2192 \u00c9nfasis Corporal y Som\u00e1tico (escaneo corporal, conciencia som\u00e1tica)
- FWL elevado \u2192 \u00c9nfasis en Sentido y Conexi\u00f3n (bondad amorosa, pr\u00e1cticas de valores)
- SRF elevado \u2192 \u00c9nfasis en el Sue\u00f1o (pr\u00e1cticas restaurativas secuenciadas primero)
- Ning\u00fan dominio \u226560% \u2192 Ruta Equilibrada (el arco completo a un ritmo parejo)
Si NBM est\u00e1 elevado, menciona tambi\u00e9n la Serie de Alimentaci\u00f3n Consciente como incluida junto al fundamento. Describe el recorrido de seis meses como un solo camino coherente.

## APOYOS NATURALES CON EVIDENCIA CIENT\u00cdFICA
4\u20136 suplementos con respaldo de investigaci\u00f3n relevantes a los dominios elevados. Para cada uno: nombre y forma, qu\u00e9 muestra la investigaci\u00f3n (breve), y precauciones/interacciones clave a verificar con un proveedor.

## CAMBIOS DE ESTILO DE VIDA ALINEADOS
4\u20136 cambios espec\u00edficos y accionables dirigidos a los dominios de mayor carga. Pr\u00e1cticos, no gen\u00e9ricos.

## SUS PR\u00d3XIMOS 7 D\u00cdAS
2\u20133 oraciones de aliento genuino, luego 3 pasos concretos para esta semana.

S\u00e9 c\u00e1lido/a, espec\u00edfico/a y directo/a. Sin descargo de responsabilidad al final.`;
}

function goalsPrompt_es(pct, ctx){
  return `Eres el m\u00f3dulo de generaci\u00f3n de metas del WAAM Clinical Engine\u2122. Con base en este perfil de bienestar WAAM\u2122, genera exactamente 5 metas S.M.A.R.T. \u2014 una para cada \u00e1rea de vida: Estado de \u00c1nimo, Sue\u00f1o, Movimiento, Nutrici\u00f3n, Relaciones. Escribe TODO en espa\u00f1ol, dirigi\u00e9ndote a la persona de usted.

CARGA POR DOMINIO (0-100%, mayor = mayor carga):
\u00c1nimo ${pct.ARM}% | Ansiedad ${pct.ATS}% | Sue\u00f1o ${pct.SRF}% | Nutrici\u00f3n ${pct.NBM}% | Movimiento ${pct.PSB}% | Satisfacci\u00f3n Vital ${pct.FWL}% | Som\u00e1tico ${pct.SSB}%
Contexto: edad ${ctx.age||"no especificada"}, duraci\u00f3n de patrones ${ctx.duration||"no especificada"}, preocupaci\u00f3n: ${ctx.concern||"ninguna"}

Calibra la ambici\u00f3n al nivel de carga \u2014 dominios de alta carga reciben metas iniciales suaves y altamente alcanzables; dominios de baja carga reciben metas de crecimiento. Las metas deben ser conductas concretas, no resultados ("caminar 10 minutos despu\u00e9s del almuerzo", no "sentirse m\u00e1s feliz").

Responde SOLO con un arreglo JSON, sin cercas de markdown, sin pre\u00e1mbulo. El campo "domain" debe ser exactamente uno de: "Estado de \u00c1nimo","Sue\u00f1o","Movimiento","Nutrici\u00f3n","Relaciones":
[{"domain":"Estado de \u00c1nimo","goal":"<meta en una oraci\u00f3n>","S":"<qu\u00e9 espec\u00edficamente>","M":"<c\u00f3mo se mide>","A":"<por qu\u00e9 es alcanzable para esta persona>","R":"<por qu\u00e9 es relevante a su perfil>","T":"<plazo \u2014 un hito temprano dentro del programa fundacional de seis meses, p. ej. \\"En 4 semanas\\" o \\"Para el final del mes 2\\">"}, ...]`;
}

function ndPrompt_es(nd, pct, wws){
  return `Eres el m\u00f3dulo Neurodivergence Insights\u2122 del WAAM Clinical Engine\u2122. Proporcionas psicoeducaci\u00f3n afirmativa de la neurodivergencia \u2014 rasgos como diferencias con fortalezas y costos, nunca d\u00e9ficits ni trastornos que corregir. Nunca diagnosticas. RESPONDE CON CALIDEZ Y ESPECIFICIDAD, todo en espa\u00f1ol, dirigi\u00e9ndote a la persona de usted.

\u00cdNDICES DE RASGOS (0\u2013100% de alineaci\u00f3n):
- WAAM-NDA\u2122 Atenci\u00f3n/Funci\u00f3n Ejecutiva/Impulsividad: ${nd.NDA}% \u2014 ${ndBand(nd.NDA,"es")}
- WAAM-NDS\u2122 Rasgos Social-Sensoriales/Autistas: ${nd.NDS}% \u2014 ${ndBand(nd.NDS,"es")}
- \u00cdndice de Enmascaramiento: ${nd.MASK}%
- Indicadores de inicio en la infancia: ${nd.CHILD?"presentes":"limitados"}
CARGA WAAM\u2122 PRINCIPAL (contexto): \u00c1nimo ${pct.ARM??"n/d"}% | Ansiedad ${pct.ATS??"n/d"}% | Sue\u00f1o ${pct.SRF??"n/d"}% | WWS\u2122 ${wws??"n/d"}

Reglas de interpretaci\u00f3n: Si enmascaramiento \u226560 con NDS 30\u201369, se\u00f1ala que las pruebas de rasgos pueden SUBestimar presentaciones enmascaradas (especialmente comunes en mujeres y en personas identificadas tarde). Si NDA \u226550 sin indicadores de infancia, se\u00f1ala con delicadeza que la identificaci\u00f3n formal de diferencias de atenci\u00f3n requiere inicio en la infancia, por lo que explorar la historia temprana con un cl\u00ednico es importante. Si la carga principal (ansiedad/\u00e1nimo/sue\u00f1o) est\u00e1 elevada junto a rasgos notables o fuertes, explica la hip\u00f3tesis descendente: el esfuerzo cr\u00f3nico de compensar rasgos no reconocidos puede generar ansiedad, agotamiento y disrupci\u00f3n del sue\u00f1o \u2014 y el apoyo que aborda los rasgos suele aliviar la carga. Si ambos \u00edndices son de baja alineaci\u00f3n, dilo con claridad y valida que sus resultados WAAM\u2122 principales siguen siendo la historia central.

Genera exactamente estas secciones (m\u00e1ximo 350 palabras en total):
## LO QUE SU PATR\u00d3N SUGIERE
## C\u00d3MO PUEDE CONECTARSE CON SUS PUNTAJES PRINCIPALES
## UNA RESPUESTA REAL EST\u00c1 DISPONIBLE
Secci\u00f3n final: 2\u20133 oraciones sobre qu\u00e9 implica y aclara una evaluaci\u00f3n formal con una proveedora psiqui\u00e1trica. Sin precios. Sin descargo final.`;
}

// ── Anthropic call ──
async function callClaude(env, prompt, maxTokens){
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error("Upstream AI error: " + res.status);
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

// ── Answer storage ──────────────────────────────────────────────────────────
// The assessment is free to take and paid to see. Responses are stored here
// after the questionnaire so they survive the round trip to Kajabi checkout —
// Kajabi cannot carry them through — and are retrieved by email afterwards.
const RETENTION_DAYS = 730;          // two years, as disclosed at the consent step
const CREDIT_HOURS   = 24;           // enrollment credit window from completion

async function emailKey(email, prefix) {
  const norm = String(email || "").trim().toLowerCase();
  const data = new TextEncoder().encode("waam:" + norm);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return (prefix || "a:") + hex.slice(0, 32);
}

const validEmail = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// A results purchase is proven one of two ways:
//   1. A purchase record written by the Kajabi webhook (/hook) — authoritative.
//   2. The tier parameter on the protected Kajabi page — presentation-level only.
// Set STRICT_PURCHASE = "true" in wrangler.toml once the webhook is wired; until
// then the tier parameter is accepted so the funnel works on day one.
// ── Kajabi: OAuth client_credentials ──
async function kajabiToken(env){
  const res = await fetch(KAJABI_API_BASE + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.KAJABI_API_KEY,
      client_secret: env.KAJABI_API_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("Kajabi OAuth failed (" + res.status + "): " + detail.slice(0, 200));
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("Kajabi OAuth response missing access_token");
  return data.access_token;
}

// ── Kajabi: authenticated GET against the Public API ────────────────────────
async function kajabiGet(token, path){
  const res = await fetch(KAJABI_API_BASE + path, {
    headers: { "Authorization": "Bearer " + token, "Accept": "application/vnd.api+json" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("Kajabi GET " + path + " failed (" + res.status + "): " + detail.slice(0, 200));
  }
  return res.json();
}

// A purchase carries only a customer id, and `include=customer` returns nothing
// on this account, so the buyer's email costs one extra call per new purchase.
async function kajabiCustomerEmail(token, customerId){
  const data = await kajabiGet(token, "/customers/" + encodeURIComponent(customerId));
  return (data && data.data && data.data.attributes && data.data.attributes.email) || "";
}

// The single definition of a purchase record, written by both /hook and the
// cron sync so the two paths cannot drift apart. Idempotent: re-recording the
// same purchase re-merges the same offer and changes nothing.
async function recordPurchase(env, email, offer){
  const key = await emailKey(email, "p:");
  const prior = (await env.WAAM_KV.get(key, "json")) || {};
  const next = {
    email: String(email).trim().toLowerCase(),
    results: true,
    enrolled: prior.enrolled || offer === "enroll" || offer === "enroll_prepaid",
    offers: [...new Set([...(prior.offers || []), offer])],
    updatedAt: new Date().toISOString(),
  };
  await env.WAAM_KV.put(key, JSON.stringify(next), { expirationTtl: RETENTION_DAYS * 86400 });
  return next;
}

// Poll Kajabi for purchases newer than the stored watermark and record each one
// belonging to a WAAM offer.
//
// Two Kajabi quirks shape this. `sort=-created_at` IS honoured, so the newest
// purchase arrives first and the walk can stop at the watermark. `filter[offer_id]`
// is NOT — it is accepted and silently ignored, exactly like `filter[email]` on
// /contacts — so rows are filtered here instead. Never trust a filter on this
// API without first proving it narrows the result.
//
// The watermark comparison is `<`, not `<=`: a purchase sharing the watermark's
// exact timestamp is re-examined next run rather than skipped. Re-recording is
// idempotent and costs one call; skipping would lose a paying customer.
async function syncPurchases(env, opts){
  const { since, limit = 100, dryRun = false } = opts || {};
  const token = await kajabiToken(env);

  const prior = typeof since === "string" ? since : ((await env.WAAM_KV.get(SYNC_WATERMARK_KEY)) || "");
  const priorMs = Date.parse(prior) || 0;

  const page = await kajabiGet(token, "/purchases?sort=-created_at&page%5Bsize%5D=" + limit);
  const rows = (page && Array.isArray(page.data)) ? page.data : [];

  let newestMs = priorMs;
  let scanned = 0;
  const recorded = [];
  const skipped = [];

  for (const row of rows) {
    const createdAt = (row && row.attributes && row.attributes.created_at) || "";
    const ms = Date.parse(createdAt) || 0;
    if (ms && ms < priorMs) break;   // newest-first: everything beyond here is older
    scanned++;
    if (ms > newestMs) newestMs = ms;

    const rel = (row && row.relationships) || {};
    const offerId = (rel.offer && rel.offer.data && rel.offer.data.id) || "";
    const offer = WAAM_OFFERS[offerId];
    if (!offer) continue;            // a purchase of some other product

    const customerId = (rel.customer && rel.customer.data && rel.customer.data.id) || "";
    if (!customerId) continue;

    // A deleted contact 404s here. That must not abort the run: the watermark
    // would stop advancing and every LATER purchase would go unrecorded, so one
    // deleted contact would leave real buyers stuck at 402 indefinitely. Skip
    // the row, report it, and carry on. The watermark still advances past it —
    // an unresolvable customer has nobody to unlock — so a genuinely transient
    // failure is recovered by re-running with since:"" rather than forever
    // pinning the watermark behind a contact that is never coming back.
    let email = "";
    try {
      email = await kajabiCustomerEmail(token, customerId);
    } catch (err) {
      skipped.push({ purchaseId: row.id, customerId, reason: String((err && err.message) || err).slice(0, 120) });
      continue;
    }
    if (!validEmail(email)) {
      skipped.push({ purchaseId: row.id, customerId, reason: "customer has no usable email" });
      continue;
    }

    if (!dryRun) await recordPurchase(env, email, offer);
    recorded.push({ purchaseId: row.id, email, offer, createdAt });
  }

  const watermark = newestMs ? new Date(newestMs).toISOString() : prior;
  if (!dryRun && newestMs > priorMs) await env.WAAM_KV.put(SYNC_WATERMARK_KEY, watermark);

  return {
    scanned,
    recorded: recorded.length,
    purchases: recorded,
    skipped: skipped.length,
    skippedDetail: skipped,
    watermark,
    dryRun: Boolean(dryRun),
  };
}

// ── Kajabi: submit the language form the way its own embed does ────────────
// Form-encoded POST to the public site, not the Public API. Three things make
// this the only path that works:
//   - api.kajabi.com/forms/{id}/submit accepts custom-field attributes and
//     silently drops them. Proven: a probe stored name and email and left all
//     seven waam_* fields empty.
//   - the form ships an authenticity_token that rotates on every fetch, but the
//     endpoint does NOT require it, so no token round-trip is needed.
//   - a custom field is only stored if it is attached to that form. Values for
//     an unattached field are accepted and discarded, with no error.
// Success is a 302 to the thank-you page, so redirects are not followed.
async function kajabiSubmit(formId, { name, email, extra }){
  const form = new URLSearchParams();
  form.set("form_submission[name]", name || email);
  form.set("form_submission[email]", email);
  for (const [key, value] of Object.entries(extra || {})) {
    const handle = KAJABI_FIELD_HANDLES[key];
    if (handle) form.set("form_submission[" + handle + "]", value);
  }

  // The site sits behind bot protection that rejects a bare Worker subrequest
  // with a 403 challenge page. These are the headers a real form post carries;
  // without them the submission never reaches Kajabi.
  const formUrl = KAJABI_SITE_BASE + "/forms/" + formId;
  const res = await fetch(formUrl + "/form_submissions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Origin": KAJABI_SITE_BASE,
      "Referer": formUrl,
    },
    body: form,
    redirect: "manual",
  });

  // 302/303 to /thank_you is the success signal; a 200 means the form was
  // re-rendered with validation errors, which is a failure worth reporting.
  if (res.status === 302 || res.status === 303) return true;
  const detail = await res.text().catch(() => "");
  throw new Error("Kajabi form submit failed (" + res.status + "): " + detail.slice(0, 200));
}

async function purchaseState(env, email) {
  if (!env.WAAM_KV) return null;
  try { return await env.WAAM_KV.get(await emailKey(email, "p:"), "json"); }
  catch { return null; }
}

// ── CORS ──
function corsHeaders(env, origin){
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? (origin || "*") : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
  };
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers });

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(env, origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, storage: Boolean(env.WAAM_KV) }, 200, headers);

    // ── Assessment pages (embedded in Kajabi via iframe) ──
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/es" || url.pathname === "/es/")) {
      const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
      const ancestors = allowed.length ? "'self' " + allowed.join(" ") : "*";
      return new Response(url.pathname.startsWith("/es") ? PAGE_ES : PAGE_EN, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "frame-ancestors " + ancestors,
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405, headers);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, headers); }

    try {
      // ── 1. SUBMIT (free) ────────────────────────────────────────────────
      // Stores the responses and returns ONLY the safety flag. No scores, no
      // analysis, no goals — a paywall enforced in the page alone would be
      // read straight out of this response with browser developer tools.
      if (url.pathname === "/submit") {
        const { email, answers, consent } = body;
        const lang = body.lang === "es" ? "es" : "en";
        if (!consent) return json({ error: "Consent is required" }, 400, headers);
        if (!validEmail(email)) return json({ error: "A valid email is required" }, 400, headers);
        if (!answers || typeof answers !== "object") return json({ error: "answers object required" }, 400, headers);
        if (!env.WAAM_KV) return json({ error: "Storage is not configured" }, 500, headers);

        const completedAt = new Date().toISOString();
        const record = { email: String(email).trim().toLowerCase(), lang, answers, completedAt };
        await env.WAAM_KV.put(await emailKey(email, "a:"), JSON.stringify(record),
          { expirationTtl: RETENTION_DAYS * 86400 });

        // The one thing released before payment: whether to show crisis resources.
        return json({ ok: true, safetyFlag: (Number(answers.arm9) || 0) > 0, completedAt }, 200, headers);
      }

      // ── 2. RESULTS (paid) ───────────────────────────────────────────────
      if (url.pathname === "/results") {
        const { email } = body;
        const tier = body.tier === "enrolled" ? "enrolled" : body.tier === "results" ? "results" : null;
        if (!validEmail(email)) return json({ error: "A valid email is required" }, 400, headers);
        if (!env.WAAM_KV) return json({ error: "Storage is not configured" }, 500, headers);

        const purchase = await purchaseState(env, email);
        const strict = String(env.STRICT_PURCHASE || "").toLowerCase() === "true";
        if (strict && !purchase) return json({ error: "No purchase found for this email" }, 402, headers);
        if (!purchase && !tier) return json({ error: "No purchase found for this email" }, 402, headers);

        const rec = await env.WAAM_KV.get(await emailKey(email, "a:"), "json");
        if (!rec) return json({ error: "notfound" }, 404, headers);

        const lang = rec.lang === "es" ? "es" : "en";
        const R = computeWAAM(rec.answers, lang);
        const route = routeWAAM(R, lang);
        const a = rec.answers;
        const ctx = {
          age: a.ctx1, dx: a.ctx2, therapy: a.ctx3,
          duration: a.ctx4, concern: String(a.ctx5 || "").slice(0, 1500),
        };
        const analysis = await callClaude(env, analysisPrompt(R, route, ctx, lang), 4000);

        const completed = Date.parse(rec.completedAt || "") || Date.now();
        const creditExpiresAt = new Date(completed + CREDIT_HOURS * 3600 * 1000).toISOString();
        const enrolled = (purchase && purchase.enrolled) || tier === "enrolled";

        return json({
          R, route, analysis, lang,
          completedAt: rec.completedAt,
          creditExpiresAt,
          creditActive: Date.now() < completed + CREDIT_HOURS * 3600 * 1000,
          enrolled,
          ctx: { age: ctx.age, duration: ctx.duration, concern: ctx.concern },
        }, 200, headers);
      }

      // ── 3. Kajabi purchase webhook ──────────────────────────────────────
      // Point a Kajabi automation here on "offer purchased". Send a JSON body
      // of { email, offer } with the shared secret in an X-WAAM-Secret header.
      // offer: "results" | "enroll" | "enroll_prepaid"
      if (url.pathname === "/hook") {
        const secret = request.headers.get("X-WAAM-Secret") || "";
        if (!env.HOOK_SECRET || secret !== env.HOOK_SECRET) return json({ error: "Unauthorized" }, 401, headers);
        if (!validEmail(body.email)) return json({ error: "A valid email is required" }, 400, headers);
        if (!env.WAAM_KV) return json({ error: "Storage is not configured" }, 500, headers);

        await recordPurchase(env, body.email, String(body.offer || "results"));
        return json({ ok: true }, 200, headers);
      }

      // ── 4. Goals (paid side only) ───────────────────────────────────────
      if (url.pathname === "/goals") {
        const pct = body.pct, ctx = body.ctx || {};
        if (!pct || typeof pct !== "object") return json({ error: "pct object required" }, 400, headers);
        ctx.concern = String(ctx.concern || "").slice(0, 1500);
        const text = (await callClaude(env, goalsPrompt(pct, ctx, body.lang === "es" ? "es" : "en"), 2500)).replace(/```json|```/g, "").trim();
        let goals;
        try { goals = JSON.parse(text); } catch { return json({ error: "Goal generation returned unparseable output — please retry" }, 502, headers); }
        if (!Array.isArray(goals)) return json({ error: "Goal generation returned unexpected shape — please retry" }, 502, headers);
        return json({ goals }, 200, headers);
      }

      // ── 5. Neurodivergence Insights (paid side only) ────────────────────
      if (url.pathname === "/nd") {
        const nd = body.nd;
        if (!nd || typeof nd !== "object") return json({ error: "nd object required" }, 400, headers);
        const analysis = await callClaude(env, ndPrompt(nd, body.pct || {}, body.wws, body.lang === "es" ? "es" : "en"), 800);
        return json({ analysis }, 200, headers);
      }

      // ── 6. Deletion request ─────────────────────────────────────────────
      if (url.pathname === "/forget") {
        if (!validEmail(body.email)) return json({ error: "A valid email is required" }, 400, headers);
        if (!env.WAAM_KV) return json({ error: "Storage is not configured" }, 500, headers);
        await env.WAAM_KV.delete(await emailKey(body.email, "a:"));
        return json({ ok: true }, 200, headers);
      }

      // ── 7. Lead capture ────────────────────────────────────────────────
      // Replaces the page's fetch(..., mode:"no-cors") POST, whose response is
      // opaque by design — a wrong form id or field name failed silently and the
      // completion was simply never recorded. The client's own launch checklist
      // flags this ("Kajabi form posting is unverified") and names this fix:
      // route it through the Worker. Still fire-and-forget from the page, so a
      // Kajabi outage never blocks someone's results.
      if (url.pathname === "/lead") {
        // No credentials needed: this posts to the public form endpoint, the
        // same one the form's own embed uses. The Public API is not involved.
        if (!validEmail(body.email)) return json({ error: "A valid email is required" }, 400, headers);
        const lang = body.lang === "es" ? "es" : "en";
        const formId = KAJABI_FORM_IDS[lang];
        if (!formId) return json({ error: 'No Kajabi form configured for language "' + lang + '"' }, 500, headers);

        // Only the assessment payload — never anything the caller invented.
        // `lang` is both the form selector and a stored field (waam_language),
        // so it is set from the normalised value rather than read from body.
        const extra = { lang };
        for (const k of ["tier", "track", "wws", "domains", "type", "purchase_tier"]) {
          const v = body[k];
          if (v !== undefined && v !== null && v !== "") extra[k] = String(v).slice(0, 500);
        }

        try {
          await kajabiSubmit(formId, {
            name: String(body.name || "").trim(),
            email: String(body.email).trim(),
            extra,
          });
          return json({ ok: true, lang, formId, fields: Object.keys(extra) }, 200, headers);
        } catch (err) {
          return json({ error: "Kajabi request failed", detail: String(err.message || err).slice(0, 300) }, 502, headers);
        }
      }

      // ── 8. Purchase sync (operator / cron-equivalent) ───────────────────
      // Same guard as /hook. Normally fired by the cron in wrangler.toml; this
      // endpoint exists so a run can be forced and inspected. Pass since:"" to
      // ignore the watermark and backfill, dryRun:true to report without writing.
      if (url.pathname === "/sync") {
        const secret = request.headers.get("X-WAAM-Secret") || "";
        if (!env.HOOK_SECRET || secret !== env.HOOK_SECRET) return json({ error: "Unauthorized" }, 401, headers);
        if (!env.KAJABI_API_KEY || !env.KAJABI_API_SECRET) {
          return json({ error: "Kajabi credentials not configured" }, 500, headers);
        }
        if (!env.WAAM_KV) return json({ error: "Storage is not configured" }, 500, headers);
        try {
          const out = await syncPurchases(env, {
            since:  typeof body.since === "string" ? body.since : undefined,
            limit:  Math.min(Math.max(Number(body.limit) || 100, 1), 100),
            dryRun: body.dryRun === true,
          });
          return json(Object.assign({ ok: true }, out), 200, headers);
        } catch (err) {
          return json({ error: "Purchase sync failed", detail: String(err.message || err).slice(0, 300) }, 502, headers);
        }
      }

      return json({ error: "Unknown endpoint" }, 404, headers);
    } catch (err) {
      return json({ error: err.message || "Server error" }, 500, headers);
    }
  },

  // Cron entry point, scheduled in wrangler.toml. See syncPurchases for why
  // this exists rather than relying on a Kajabi webhook. Errors are logged and
  // swallowed: a failed run is retried by the next tick, and the watermark only
  // advances over rows actually examined, so nothing is skipped.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      syncPurchases(env)
        .then(r => console.log("WAAM purchase sync:", JSON.stringify(r)))
        .catch(err => console.error("WAAM purchase sync failed:", (err && err.message) || err))
    );
  },
};
