// Kajabi Proxy — Next.js App Router API Route
// Submits a Kajabi FORM on behalf of the assessment taker, then tags the contact.
//
// Why a form (and not a raw contact create): submitting a form is what OPTS THE
// CONTACT IN to email marketing. Contacts created through the /contacts API land as
// "Never subscribed", and Kajabi will not send marketing/automation emails to them —
// which is why the assessment follow-up email never arrived. A form submission fixes
// that opt-in. After it succeeds we look the contact up by email and attach the
// language tag ourselves, so the follow-up automation reliably fires (best-effort —
// the opt-in has already happened, so a tagging hiccup never fails the request).
//
// REQUIREMENT (configured in Kajabi, NOT here): each form must be SINGLE opt-in.
// If a form is left on the default DOUBLE opt-in, the taker gets a confirmation email
// and stays unsubscribed until they click it — so no automation email goes out.
//
// All secrets stay server-side. Set these in Vercel → Settings → Environment Variables:
//   KAJABI_API_KEY     — Kajabi API Key    (used as OAuth client_id)
//   KAJABI_API_SECRET  — Kajabi API Secret (used as OAuth client_secret)
//   KAJABI_SITE_ID     — numeric Site ID   (used to look up the contact + resolve tags)
//   KAJABI_FORM_ID_EN  — English form id   (optional; defaults below)
//   KAJABI_FORM_ID_ES  — Spanish form id   (optional; defaults below)
//   ALLOWED_ORIGINS    — comma-separated allowed origins (optional; defaults to *)
//
// Kajabi API reference: https://help.kajabi.com/api-reference/forms/submit-form
// Flow: OAuth token → POST /v1/forms/{id}/submit → find contact → attach tag(s).

const KAJABI_API_BASE = 'https://api.kajabi.com/v1';

// Language → Kajabi form id. These ids are not secret; env vars allow overriding
// them without a code change (a Vercel redeploy is still required either way).
const FORM_IDS = {
  en: process.env.KAJABI_FORM_ID_EN || '2149686351', // "Assessment Form - English"
  es: process.env.KAJABI_FORM_ID_ES || '2149686352', // "Assessment Form - Spanish"
};

// Base automation tag per language (fallback if the embed sends no tags array).
const BASE_TAG = {
  en: 'assessment-complete',
  es: 'assessment-complete-spanish',
};

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '*')
  .split(',').map(s => s.trim());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// This is the call that opts the contact in (single opt-in) + fires anything the
// form itself is configured to do.
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

// ── Step 3: Find the contact id by email ──────────────────────────────────
// Kajabi's contact `filter[search]` is index-backed and LAGS — a contact created
// milliseconds earlier isn't searchable yet, so it can't be relied on right after a
// form submit. The API is Ransack-style (we already use `filter[name_cont]`), so we
// try direct DB predicates first (`email_eq`, then `email_cont`) which see a just-
// created row immediately, and only fall back to `search`. Returns { id, status,
// count, via } so the caller can report which method hit (or why none did).
async function queryContacts(token, siteId, params) {
  const qs = new URLSearchParams({ 'filter[site_id]': String(siteId), 'page[size]': '100', ...params });
  const res = await fetch(`${KAJABI_API_BASE}/contacts?${qs.toString()}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.api+json' },
  });
  if (!res.ok) return { status: res.status, data: [] };
  const json = await res.json().catch(() => ({}));
  return { status: res.status, data: json.data || [] };
}

async function findContactId(token, siteId, email) {
  const lower = email.toLowerCase();
  const exact = (list) => list.find((c) => (c.attributes?.email || '').toLowerCase() === lower);
  const local = email.split('@')[0] || '';
  const baseLocal = local.split('+')[0]; // strip Gmail "+tag" for the last-ditch search

  const attempts = [
    { via: 'email_eq', params: { 'filter[email_eq]': email } },
    { via: 'email_cont', params: { 'filter[email_cont]': email } },
    { via: 'search_full', params: { 'filter[search]': email } },
  ];
  if (baseLocal && baseLocal !== local) {
    attempts.push({ via: 'search_base', params: { 'filter[search]': baseLocal } });
  }

  let status = null;
  let count = 0;
  for (const a of attempts) {
    const r = await queryContacts(token, siteId, a.params);
    status = r.status;
    count += r.data.length;
    const match = exact(r.data);
    if (match) return { id: match.id, status: r.status, count: r.data.length, via: a.via };
  }
  return { id: null, status, count, via: null };
}

// ── Step 4: Resolve a tag NAME to its numeric id (tags must already exist) ─
async function findTagId(token, siteId, name) {
  const url = `${KAJABI_API_BASE}/contact_tags`
    + `?filter[site_id]=${encodeURIComponent(siteId)}`
    + `&filter[name_cont]=${encodeURIComponent(name)}`
    + `&page[size]=100`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.api+json' },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => ({}));
  // name_cont is a "contains" match — pick the exact (case-insensitive) name.
  const match = (json.data || []).find(
    (t) => (t.attributes?.name || '').toLowerCase() === name.toLowerCase()
  );
  return match ? match.id : null;
}

// ── Step 5: Attach tag id(s) to the contact ──────────────────────────────
async function addTags(token, contactId, tagIds) {
  if (!tagIds.length) return;
  await fetch(`${KAJABI_API_BASE}/contacts/${contactId}/relationships/tags`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({ data: tagIds.map((id) => ({ type: 'contact_tags', id: String(id) })) }),
  });
}

// Pick EN vs ES from the payload the embeds already send — no embed change needed.
// Primary signal: customFields.assessment_language ('en'|'es'). Fallbacks: an explicit
// body.lang, then any "spanish" tag (ES base tag is `assessment-complete-spanish`).
function resolveLang(body) {
  const explicit = String(body.lang || body?.customFields?.assessment_language || '').toLowerCase();
  if (explicit === 'es' || explicit === 'en') return explicit;
  const tags = Array.isArray(body.tags) ? body.tags : [];
  if (tags.some((t) => String(t).toLowerCase().includes('spanish'))) return 'es';
  return 'en';
}

export async function POST(request) {
  const cors = corsHeaders(request);
  const clientId = process.env.KAJABI_API_KEY;
  const clientSecret = process.env.KAJABI_API_SECRET;
  const siteId = process.env.KAJABI_SITE_ID;

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

    // ── Best-effort tagging ────────────────────────────────────────────────
    // The form submit already opted the contact in; now attach the language tag
    // so the automation fires. Any failure here is non-fatal (opt-in succeeded).
    // Apply whatever tags the embed sent; fall back to the base language tag.
    const wantTags = (Array.isArray(body.tags) && body.tags.length)
      ? body.tags.filter(Boolean)
      : [BASE_TAG[lang]].filter(Boolean);

    let contactId = null;
    let lookupVia;
    const tagsApplied = [];
    const tagsMissing = [];
    let tagNote;

    try {
      if (!siteId) {
        tagNote = 'KAJABI_SITE_ID not set; tagging skipped';
      } else {
        // The contact can take a beat to be queryable right after submission.
        let lookup = await findContactId(token, siteId, email);
        if (!lookup.id) { await sleep(800); lookup = await findContactId(token, siteId, email); }
        contactId = lookup.id;

        if (!contactId) {
          tagNote = `contact not found after submit; tagging skipped `
            + `(status=${lookup.status}, seen=${lookup.count})`;
        } else {
          lookupVia = lookup.via;
          const tagIds = [];
          for (const tagName of wantTags) {
            const id = await findTagId(token, siteId, tagName);
            if (id) { tagIds.push(id); tagsApplied.push(tagName); } else { tagsMissing.push(tagName); }
          }
          if (tagIds.length) await addTags(token, contactId, tagIds);
        }
      }
    } catch (tagErr) {
      tagNote = `tagging error: ${String(tagErr.message || tagErr).slice(0, 200)}`;
    }

    return Response.json(
      {
        ok: true,
        lang,
        formId,
        formSubmissionId,
        contactId,
        ...(lookupVia ? { lookupVia } : {}),
        tagsApplied,
        tagsMissing,
        ...(tagNote ? { tagNote } : {}),
      },
      { status: 200, headers: cors }
    );
  } catch (err) {
    return Response.json(
      { error: 'Kajabi request failed', detail: String(err.message || err).slice(0, 400) },
      { status: 502, headers: cors }
    );
  }
}
