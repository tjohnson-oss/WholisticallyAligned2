// Kajabi Proxy — Next.js App Router API Route
// Keeps the Kajabi API key server-side only.
// Set KAJABI_API_KEY and KAJABI_SITE_URL in Vercel environment variables.

// ALLOWED_ORIGINS: comma-separated list of allowed origins
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

export async function POST(request) {
  const apiKey = process.env.KAJABI_API_KEY;
  const siteUrl = process.env.KAJABI_SITE_URL;

  if (!apiKey || !siteUrl) {
    return Response.json(
      { error: 'Kajabi credentials not configured' },
      { status: 500, headers: corsHeaders(request) }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers: corsHeaders(request) }
    );
  }

  const kajabiRes = await fetch(`${siteUrl}/api/v1/contacts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await kajabiRes.json().catch(() => ({}));

  return Response.json(data, {
    status: kajabiRes.status,
    headers: corsHeaders(request),
  });
}
