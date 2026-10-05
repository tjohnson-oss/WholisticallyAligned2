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

// ── Kajabi lead capture ──────────────────────────────────────────────
// Ported from the Vercel proxy (app/api/kajabi/route.js), which was verified
// end-to-end: OAuth -> form submit -> automation email received, both languages.
//
// Submitting a FORM (not creating a contact) is what OPTS THE CONTACT IN.
// Contacts made via /contacts land as "Never subscribed" and receive no
// marketing or automation email. Tagging and the follow-up sequence are handled
// FORM-SIDE in Kajabi, because Kajabi creates the contact asynchronously after
// this call returns and it cannot be tagged reliably from within this request.
//
// REQUIRED in Kajabi (not here): each form must be SINGLE opt-in. A form left on
// the default double opt-in leaves the taker unsubscribed until they confirm, so
// no automation email goes out.
//
// Secrets (wrangler secret put ...): KAJABI_API_KEY, KAJABI_API_SECRET
//   — these are the OAuth client_id / client_secret from
//     Kajabi -> Settings -> Public API (NOT Account Details).
const KAJABI_API_BASE = "https://api.kajabi.com/v1";
const KAJABI_FORM_IDS = {
  en: "2149686351", // "Assessment Form - English"
  es: "2149686352", // "Assessment Form - Spanish"
};

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
  let primary;
  if(p.ARM>=EL&&p.ATS>=EL)      primary={key:"dbt",offer:"dbt",icon:"🧭",name:"DBT Emotional Regulation",why:"Your mood and anxiety domains are both elevated — DBT's distress tolerance and emotion regulation skills (TIPP, ACCEPTS) are built precisely for this combination."};
  else if(p.ARM>=EL)            primary={key:"mbsr-er-mood",offer:"mbsrER",icon:"☁️",name:"MBSR Emotional Regulation",why:"Your mood domain carries the highest burden — this program's behavioral activation through mindful engagement directly targets low mood and depleted energy. (A dedicated CBT series is coming soon.)"};
  else if(p.ATS>=EL)            primary={key:"mbsr-er-anxiety",offer:"mbsrER",icon:"🌀",name:"MBSR Emotional Regulation",why:"Your anxiety domain is elevated — the worry-decentering and nervous system regulation practices here are your best current match. (An ACT series is coming soon.)"};
  else if(p.NBM>=EL)            primary={key:"mindful-eating",offer:"eating",icon:"🌿",name:"Mindful Eating 8-Week Series",why:"Your nutrition domain shows the greatest burden — this dedicated program heals your relationship with food, hunger, and nourishment. Available in English and Spanish."};
  else if(p.SSB>=EL)            primary={key:"mbsr-er-somatic",offer:"mbsrER",icon:"🫀",name:"MBSR Emotional Regulation (Body-Scan Emphasis)",why:"Your body is carrying significant stress expression — body-scan and somatic awareness practices are the evidence-based response."};
  else if(p.FWL>=EL)            primary={key:"mbsr-er-meaning",offer:"mbsrER",icon:"✨",name:"MBSR Emotional Regulation (Loving-Kindness Path)",why:"Your life satisfaction domain is elevated — the loving-kindness and values practices here rebuild meaning and connection."};
  else if(p.SRF>=EL)            primary={key:"mbsr-sleep",offer:"foundation",icon:"🌙",name:"MBSR Foundation (Sleep Priority)",why:"Sleep carries your highest burden — the foundation's restorative practices will be sequenced to prioritize your sleep architecture."};
  else                          primary={key:"growth",offer:"foundation",icon:"🌱",name:"Growth Track of Your Choice",why:"No domain shows significant burden — you're positioned to choose the growth path that speaks to you most."};

  const secondary=(p.NBM>=EL&&primary.key!=="mindful-eating")?{key:"mindful-eating",offer:"eating",icon:"🌿",name:"Mindful Eating 8-Week Series",why:"Your nutrition domain is also elevated — this pairs well as a second-phase program."}:null;

  const w=R.wws;
  const foundation=
    w>=80?{mode:"optional",label:"Optional Enrichment",desc:"Your six-month Foundational MBSR-Informed Wellness Program is optional at your wellness level — but recommended as the foundation that deepens every other practice."}
    :w>=50?{mode:"sequential",label:"Start Here — Your Foundation",desc:"Begin with the MBSR Core phase, then your Integration Bridge carries you into your matched track — one continuous six-month journey, with early gains typically emerging in weeks 4–6."}
    :w>=35?{mode:"parallel",label:"Foundation + Track Together",desc:"You'll take a condensed MBSR Core alongside your matched track from the start — building the six-month foundation without delaying the individualized support you need now."}
    :{mode:"parallel-care",label:"Foundation + Track + Professional Care",desc:"A condensed MBSR Core runs alongside your matched track. At your current burden level, we also warmly encourage connecting with a licensed professional — your programs work best as a complement to care."};

  return {primary,secondary,foundation};
}


function routeWAAM_es(R){
  const p=R.pct, EL=60;
  let primary;
  if(p.ARM>=EL&&p.ATS>=EL)      primary={key:"dbt",offer:"dbt",icon:"\u{1F9ED}",name:"Regulaci\u00f3n Emocional DBT",why:"Sus dominios de \u00e1nimo y ansiedad est\u00e1n ambos elevados \u2014 las habilidades de tolerancia al malestar y regulaci\u00f3n emocional de la DBT (TIPP, ACCEPTS) est\u00e1n dise\u00f1adas precisamente para esta combinaci\u00f3n."};
  else if(p.ARM>=EL)            primary={key:"mbsr-er-mood",offer:"mbsrER",icon:"\u2601\uFE0F",name:"Regulaci\u00f3n Emocional MBSR",why:"Su dominio de \u00e1nimo carga el mayor peso \u2014 la activaci\u00f3n conductual mediante el compromiso consciente de este programa aborda directamente el \u00e1nimo bajo y la energ\u00eda agotada. (Pr\u00f3ximamente una serie dedicada de TCC.)"};
  else if(p.ATS>=EL)            primary={key:"mbsr-er-anxiety",offer:"mbsrER",icon:"\u{1F300}",name:"Regulaci\u00f3n Emocional MBSR",why:"Su dominio de ansiedad est\u00e1 elevado \u2014 las pr\u00e1cticas de descentramiento de la preocupaci\u00f3n y regulaci\u00f3n del sistema nervioso son su mejor opci\u00f3n actual. (Pr\u00f3ximamente una serie de ACT.)"};
  else if(p.NBM>=EL)            primary={key:"mindful-eating",offer:"eating",icon:"\u{1F33F}",name:"Serie de Alimentaci\u00f3n Consciente de 8 Semanas",why:"Su dominio de nutrici\u00f3n muestra la mayor carga \u2014 este programa dedicado sana su relaci\u00f3n con la comida, el hambre y la nutrici\u00f3n. Disponible en ingl\u00e9s y espa\u00f1ol."};
  else if(p.SSB>=EL)            primary={key:"mbsr-er-somatic",offer:"mbsrER",icon:"\u{1FAC0}",name:"Regulaci\u00f3n Emocional MBSR (\u00c9nfasis en Escaneo Corporal)",why:"Su cuerpo carga una expresi\u00f3n significativa del estr\u00e9s \u2014 el escaneo corporal y la conciencia som\u00e1tica son la respuesta basada en evidencia."};
  else if(p.FWL>=EL)            primary={key:"mbsr-er-meaning",offer:"mbsrER",icon:"\u2728",name:"Regulaci\u00f3n Emocional MBSR (Ruta de Bondad Amorosa)",why:"Su dominio de satisfacci\u00f3n vital est\u00e1 elevado \u2014 las pr\u00e1cticas de bondad amorosa y valores reconstruyen el significado y la conexi\u00f3n."};
  else if(p.SRF>=EL)            primary={key:"mbsr-sleep",offer:"foundation",icon:"\u{1F319}",name:"Fundamento MBSR (Prioridad de Sue\u00f1o)",why:"El sue\u00f1o carga su mayor peso \u2014 las pr\u00e1cticas restaurativas del fundamento se secuenciar\u00e1n para priorizar su arquitectura del sue\u00f1o."};
  else                          primary={key:"growth",offer:"foundation",icon:"\u{1F331}",name:"Ruta de Crecimiento a Su Elecci\u00f3n",why:"Ning\u00fan dominio muestra carga significativa \u2014 usted est\u00e1 en posici\u00f3n de elegir la ruta de crecimiento que m\u00e1s le hable."};

  const secondary=(p.NBM>=EL&&primary.key!=="mindful-eating")?{key:"mindful-eating",offer:"eating",icon:"\u{1F33F}",name:"Serie de Alimentaci\u00f3n Consciente de 8 Semanas",why:"Su dominio de nutrici\u00f3n tambi\u00e9n est\u00e1 elevado \u2014 combina bien como programa de segunda fase."}:null;

  const w=R.wws;
  const foundation=
    w>=80?{mode:"optional",label:"Enriquecimiento Opcional",desc:"Su Programa Fundacional de Bienestar Informado por MBSR de seis meses es opcional en su nivel de bienestar \u2014 pero se recomienda como el fundamento que profundiza toda otra pr\u00e1ctica."}
    :w>=50?{mode:"sequential",label:"Comience Aqu\u00ed \u2014 Su Fundamento",desc:"Comience con la fase del N\u00facleo MBSR; luego su Puente de Integraci\u00f3n le lleva a su ruta asignada \u2014 un recorrido continuo de seis meses, con avances tempranos que suelen surgir en las semanas 4\u20136."}
    :w>=35?{mode:"parallel",label:"Fundamento + Ruta Juntos",desc:"Tomar\u00e1 un N\u00facleo MBSR condensado junto con su ruta asignada desde el inicio \u2014 construyendo el fundamento de seis meses sin demorar el apoyo individualizado que necesita ahora."}
    :{mode:"parallel-care",label:"Fundamento + Ruta + Atenci\u00f3n Profesional",desc:"Un N\u00facleo MBSR condensado avanza junto a su ruta asignada. En su nivel actual de carga, tambi\u00e9n le animamos c\u00e1lidamente a conectar con un profesional licenciado \u2014 sus programas funcionan mejor como complemento de la atenci\u00f3n."};

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
- ARM and ATS both elevated → DBT Emotional Regulation program (distress tolerance, TIPP, emotion regulation skills)
- ARM elevated alone → MBSR Emotional Regulation program (behavioral activation through mindful engagement); note a dedicated CBT series is coming soon
- ATS elevated alone → MBSR Emotional Regulation program (worry decentering); note an ACT series is coming soon
- NBM elevated → Mindful Eating 8-Week Series (available in English and Spanish)
- SRF elevated → sleep-focused practices within the MBSR foundation; flag their sleep burden for priority attention
- SSB elevated → MBSR Emotional Regulation with body-scan emphasis
- FWL elevated → MBSR Emotional Regulation (loving-kindness and values practices)
- No domain ≥60% → foundation plus their choice of growth track
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
- Deterioro Significativo (35\u201349): un N\u00facleo MBSR condensado avanza EN PARALELO con su ruta asignada \u2014 no debe esperar meses para el apoyo individualizado.
- Necesidad Cl\u00ednica Aguda (0\u201334): N\u00facleo MBSR en paralelo con su ruta asignada, M\u00c1S un aliento claro y c\u00e1lido a buscar tambi\u00e9n atenci\u00f3n profesional ahora.

Luego nombra su(s) ruta(s) asignada(s) usando exactamente esta l\u00f3gica contra sus cargas por dominio (\u226560% = elevado):
- ARM y ATS ambos elevados \u2192 programa Regulaci\u00f3n Emocional DBT (tolerancia al malestar, TIPP, habilidades de regulaci\u00f3n emocional)
- Solo ARM elevado \u2192 programa Regulaci\u00f3n Emocional MBSR (activaci\u00f3n conductual mediante compromiso consciente); menciona que pr\u00f3ximamente habr\u00e1 una serie dedicada de TCC
- Solo ATS elevado \u2192 programa Regulaci\u00f3n Emocional MBSR (descentramiento de la preocupaci\u00f3n); menciona que pr\u00f3ximamente habr\u00e1 una serie de ACT
- NBM elevado \u2192 Serie de Alimentaci\u00f3n Consciente de 8 Semanas (disponible en ingl\u00e9s y espa\u00f1ol)
- SRF elevado \u2192 pr\u00e1cticas enfocadas en el sue\u00f1o dentro del fundamento MBSR; se\u00f1ala su carga de sue\u00f1o para atenci\u00f3n prioritaria
- SSB elevado \u2192 Regulaci\u00f3n Emocional MBSR con \u00e9nfasis en escaneo corporal
- FWL elevado \u2192 Regulaci\u00f3n Emocional MBSR (pr\u00e1cticas de bondad amorosa y valores)
- Ning\u00fan dominio \u226560% \u2192 fundamento m\u00e1s la ruta de crecimiento de su elecci\u00f3n
Nombra el/los programa(s) espec\u00edfico(s) de Wholistically Aligned, explica en una oraci\u00f3n por qu\u00e9 cada programa encaja con su patr\u00f3n exacto de puntajes, y describe la secuencia fundamento\u2192ruta como un solo recorrido coherente.

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

// ── Kajabi: OAuth client-credentials token ──
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

// ── Kajabi: submit the language form (JSON:API). Returns the submission id. ──
// This opts the contact in and fires the form's own automations inside Kajabi's
// async submission job — race-free, unlike tagging from here.
async function kajabiSubmit(token, formId, { name, email }){
  const res = await fetch(KAJABI_API_BASE + "/forms/" + formId + "/submit", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/vnd.api+json",
      "Accept": "application/vnd.api+json",
    },
    // name + email are the only required attributes; email must be deliverable.
    // TODO(client): once the six Kajabi custom-field names are supplied, add them
    // here so tier / track / wws / lang / domains / type reach the contact record.
    body: JSON.stringify({
      data: { type: "form_submissions", attributes: { name: name || email, email } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error("Kajabi submit failed (" + res.status + "): " + JSON.stringify(data).slice(0, 200));
  }
  return data?.data?.id;
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
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true }, 200, headers);

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
      if (url.pathname === "/assess") {
        const answers = body.answers;
        if (!answers || typeof answers !== "object") return json({ error: "answers object required" }, 400, headers);
        const lang = body.lang === "es" ? "es" : "en";
        const R = computeWAAM(answers, lang);
        const route = routeWAAM(R, lang);
        const ctx = {
          age: answers.ctx1, dx: answers.ctx2, therapy: answers.ctx3,
          duration: answers.ctx4, concern: String(answers.ctx5 || "").slice(0, 1500),
        };
        const analysis = await callClaude(env, analysisPrompt(R, route, ctx, lang), 4000);
        return json({ R, route, analysis }, 200, headers);
      }

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

      if (url.pathname === "/nd") {
        const nd = body.nd;
        if (!nd || typeof nd !== "object") return json({ error: "nd object required" }, 400, headers);
        const analysis = await callClaude(env, ndPrompt(nd, body.pct || {}, body.wws, body.lang === "es" ? "es" : "en"), 800);
        return json({ analysis }, 200, headers);
      }

      // ── Lead capture: opts the taker in via the Kajabi language form ──
      if (url.pathname === "/lead") {
        if (!env.KAJABI_API_KEY || !env.KAJABI_API_SECRET) {
          return json({ error: "Kajabi credentials not configured" }, 500, headers);
        }
        const email = String(body.email || "").trim();
        const name  = String(body.name  || "").trim();
        if (!email || !email.includes("@")) {
          return json({ error: "A valid email is required" }, 400, headers);
        }
        const lang = body.lang === "es" ? "es" : "en";
        const formId = KAJABI_FORM_IDS[lang];
        if (!formId) return json({ error: 'No Kajabi form configured for language "' + lang + '"' }, 500, headers);
        try {
          const token = await kajabiToken(env);
          const formSubmissionId = await kajabiSubmit(token, formId, { name, email });
          return json({ ok: true, lang, formId, formSubmissionId }, 200, headers);
        } catch (err) {
          return json({ error: "Kajabi request failed", detail: String(err.message || err).slice(0, 300) }, 502, headers);
        }
      }

      return json({ error: "Unknown endpoint" }, 404, headers);
    } catch (err) {
      return json({ error: err.message || "Server error" }, 500, headers);
    }
  },
};
