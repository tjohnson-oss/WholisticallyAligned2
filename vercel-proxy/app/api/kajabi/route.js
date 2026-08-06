// Kajabi Proxy — Next.js App Router API Route
// Submits a Kajabi FORM on behalf of the assessment taker via Kajabi's Public API.
//
// Why a form (and not a raw contact create): submitting a form is what OPTS THE
// CONTACT IN to email marketing. Contacts created through the /contacts API land as
// "Never subscribed", and Kajabi will not send marketing/automation emails to them —
// which is why the assessment follow-up email never arrived. A form submission fixes
// that. Per each form's own Kajabi config, this single call also:
//   • subscribes the contact (opt-in)         ← the fix
//   • adds the form's tag(s)                   ← e.g. assessment-complete / -spanish
//   • triggers the attached automation(s) / sequences
//
// REQUIREMENT (configured in Kajabi, NOT here): each form must be SINGLE opt-in, and
// must add its language tag (or have the automation attached) so the sequence fires.
// If a form is left on the default DOUBLE opt-in, the taker gets a confirmation email
// and stays unsubscribed until they click it — so no automation email goes out.
//
// All secrets stay server-side. Set these in Vercel → Settings → Environment Variables:
//   KAJABI_API_KEY     — Kajabi API Key    (used as OAuth client_id)
//   KAJABI_API_SECRET  — Kajabi API Secret (used as OAuth client_secret)
//   KAJABI_FORM_ID_EN  — English form id   (optional; defaults below)
//   KAJABI_FORM_ID_ES  — Spanish form id   (optional; defaults below)
//   ALLOWED_ORIGINS    — comma-separated allowed origins (optional; defaults to *)
//
// Kajabi API reference: https://help.kajabi.com/api-reference/forms/submit-form
// Flow: OAuth token → POST /v1/forms/{id}/submit  (JSON:API, Bearer auth).

const KAJABI_API_BASE = 'https://api.kajabi.com/v1';

// Language → Kajabi form id. These ids are not secret; env vars allow overriding
// them without a code change (a Vercel redeploy is still required either way).
const FORM_IDS = {
  en: process.env.KAJABI_FORM_ID_EN || '2149686351', // "Assessment Form - English"
  es: process.env.KAJABI_FORM_ID_ES || '2149686352', // "Assessment Form - Spanish"
};

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '*')
  .split(',').map(s => s.trim());

function corsHeaders(request) {
  const origin = request?.headers?.get('origin') || '';
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin || '*' : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

// ── Step 1: OAuth client-credentials token ───────────────────────────────
async function getAccessToken(clientId, clientSecret) {
  const res = await fetch(`${KAJABI_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OAuth token failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('OAuth response missing access_token');
  return json.access_token;
}

// ── Step 2: Submit the form (JSON:API). Returns the new form_submission id. ─
// This is the call that opts the contact in + fires the form's tags/automation.
async function submitForm(token, formId, { name, email }) {
  const res = await fetch(`${KAJABI_API_BASE}/forms/${formId}/submit`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'form_submissions',
        // name + email are the only required attributes; email must be deliverable.
        attributes: { name: name || email, email },
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Submit form failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json?.data?.id;
}

// Pick EN vs ES from the payload the embeds already send — no embed change needed.
// Primary signal: customFields.assessment_language ('en'|'es'). Fallbacks: an explicit
// body.lang, then any "spanish" tag (ES base tag is `assessment-complete-spanish`).
function resolveLang(body) {
  const explicit = String(body.lang || body?.customFields?.assessment_language || '').toLowerCase();
  if (explicit === 'es' || explicit === 'en') return explicit;
  const tags = Array.isArray(body.tags) ? body.tags : [];
  if (tags.some(t => String(t).toLowerCase().includes('spanish'))) return 'es';
  return 'en';
}

export async function POST(request) {
  const cors = corsHeaders(request);
  const clientId = process.env.KAJABI_API_KEY;
  const clientSecret = process.env.KAJABI_API_SECRET;

  if (!clientId || !clientSecret) {
    return Response.json(
      { error: 'Kajabi credentials not configured (need KAJABI_API_KEY, KAJABI_API_SECRET)' },
      { status: 500, headers: cors }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const email = (body.email || '').trim();
  const name = (body.name || '').trim();

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'A valid email is required' }, { status: 400, headers: cors });
  }

  const lang = resolveLang(body);
  const formId = FORM_IDS[lang];
  if (!formId) {
    return Response.json(
      { error: `No Kajabi form configured for language "${lang}"` },
      { status: 500, headers: cors }
    );
  }

  try {
    const token = await getAccessToken(clientId, clientSecret);
    const formSubmissionId = await submitForm(token, formId, { name, email });

    return Response.json(
      { ok: true, lang, formId, formSubmissionId },
      { status: 200, headers: cors }
    );
  } catch (err) {
    return Response.json(
      { error: 'Kajabi request failed', detail: String(err.message || err).slice(0, 400) },
      { status: 502, headers: cors }
    );
  }
}
