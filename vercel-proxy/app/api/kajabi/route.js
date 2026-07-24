// Kajabi Proxy — Next.js App Router API Route
// Creates a Kajabi contact and applies tag(s) via Kajabi's official Public API.
// All secrets stay server-side. Set these in Vercel → Settings → Environment Variables:
//   KAJABI_API_KEY     — your Kajabi API Key    (used as OAuth client_id)
//   KAJABI_API_SECRET  — your Kajabi API Secret (used as OAuth client_secret)
//   KAJABI_SITE_ID     — your numeric Kajabi Site ID (required to create a contact)
//   ALLOWED_ORIGINS    — comma-separated allowed origins (optional; defaults to *)
//
// Kajabi API reference: https://help.kajabi.com/llms.txt
// Flow: OAuth token → create contact → resolve tag name→id → attach tag(s).

const KAJABI_API_BASE = 'https://api.kajabi.com/v1';

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

// ── Step 2: Create the contact (JSON:API). Returns the new contact id. ────
async function createContact(token, siteId, { name, email }) {
  const res = await fetch(`${KAJABI_API_BASE}/contacts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'contacts',
        attributes: { name: name || email, email },
        // The site relationship is mandatory for contact creation.
        relationships: { site: { data: { type: 'sites', id: String(siteId) } } },
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Create contact failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json?.data?.id;
}

// ── Step 3: Resolve a tag NAME to its numeric id (tags must already exist) ─
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
    t => (t.attributes?.name || '').toLowerCase() === name.toLowerCase()
  );
  return match ? match.id : null;
}

// ── Step 4: Attach tag id(s) to the contact ──────────────────────────────
async function addTags(token, contactId, tagIds) {
  if (!tagIds.length) return;
  await fetch(`${KAJABI_API_BASE}/contacts/${contactId}/relationships/tags`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({ data: tagIds.map(id => ({ type: 'contact_tags', id: String(id) })) }),
  });
}

export async function POST(request) {
  const cors = corsHeaders(request);
  const clientId = process.env.KAJABI_API_KEY;
  const clientSecret = process.env.KAJABI_API_SECRET;
  const siteId = process.env.KAJABI_SITE_ID;

  if (!clientId || !clientSecret || !siteId) {
    return Response.json(
      { error: 'Kajabi credentials not configured (need KAJABI_API_KEY, KAJABI_API_SECRET, KAJABI_SITE_ID)' },
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
  const tags = Array.isArray(body.tags) ? body.tags.filter(Boolean) : [];

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'A valid email is required' }, { status: 400, headers: cors });
  }

  try {
    const token = await getAccessToken(clientId, clientSecret);
    const contactId = await createContact(token, siteId, { name, email });

    // Best-effort tagging: resolve each tag name to an id and apply those that exist.
    // Tags that don't exist in Kajabi are skipped (never block signup) and reported back.
    const applied = [], missing = [], tagIds = [];
    for (const tagName of tags) {
      const id = await findTagId(token, siteId, tagName);
      if (id) { tagIds.push(id); applied.push(tagName); } else { missing.push(tagName); }
    }
    if (tagIds.length) await addTags(token, contactId, tagIds);

    return Response.json(
      { ok: true, contactId, tagsApplied: applied, tagsMissing: missing },
      { status: 200, headers: cors }
    );
  } catch (err) {
    return Response.json(
      { error: 'Kajabi request failed', detail: String(err.message || err).slice(0, 400) },
      { status: 502, headers: cors }
    );
  }
}
