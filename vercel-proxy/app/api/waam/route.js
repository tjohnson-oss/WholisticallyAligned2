// WAAM™ Proxy — Next.js App Router API Route
// Deployed on Vercel. Keeps the Anthropic API key server-side only.
// Set ANTHROPIC_API_KEY and ALLOWED_ORIGIN in Vercel environment variables.

// Long-running: the WAAM analysis can take ~60-70s at max_tokens 4000.
// Without this, Vercel's default cap can 504 the request mid-generation.
export const maxDuration = 120;

// ALLOWED_ORIGINS: comma-separated list of allowed origins
// e.g. "https://www.wholisticallyaligned.com,https://wholisticallyaligned.mykajabi.com"
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'API key not configured' },
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

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await anthropicRes.json();

  return Response.json(data, {
    status: anthropicRes.status,
    headers: corsHeaders(request),
  });
}
