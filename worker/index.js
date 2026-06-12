/**
 * CityHUB API Worker — Cloudflare Worker
 * Proxies requests to Anthropic Claude API while keeping the API key on the server.
 *
 * Endpoints:
 *   POST /api/chat   — stream Claude response (SSE)
 *
 * Environment vars (set via `wrangler secret put`):
 *   ANTHROPIC_API_KEY  — Roch's Claude API key
 *
 * Bindings (set in wrangler.toml):
 *   RATE_LIMIT (KV namespace) — per-user daily counters
 *   ALLOWED_ORIGIN (env var) — comma-separated list of allowed origins
 */

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 600;
const DAILY_LIMIT_PER_USER = 80;     // per-Telegram-user safety
const DAILY_LIMIT_GLOBAL = 8000;     // ~$12/day cap for the whole app

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-CityHUB-User',
    'Access-Control-Max-Age': '86400',
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function checkRateLimit(env, userId) {
  if (!env.RATE_LIMIT) return { ok: true };
  const day = todayKey();
  const userKey = `u:${userId}:${day}`;
  const globalKey = `g:${day}`;
  const [u, g] = await Promise.all([
    env.RATE_LIMIT.get(userKey),
    env.RATE_LIMIT.get(globalKey),
  ]);
  const uCount = parseInt(u || '0', 10);
  const gCount = parseInt(g || '0', 10);
  if (gCount >= DAILY_LIMIT_GLOBAL) return { ok: false, reason: 'global' };
  if (userId !== 'anon' && uCount >= DAILY_LIMIT_PER_USER) return { ok: false, reason: 'user' };
  return { ok: true, uCount, gCount };
}

async function bumpRateLimit(env, userId) {
  if (!env.RATE_LIMIT) return;
  const day = todayKey();
  const userKey = `u:${userId}:${day}`;
  const globalKey = `g:${day}`;
  const ttl = 60 * 60 * 36; // 36h — auto-expires next day
  const [u, g] = await Promise.all([
    env.RATE_LIMIT.get(userKey),
    env.RATE_LIMIT.get(globalKey),
  ]);
  await Promise.all([
    env.RATE_LIMIT.put(userKey, String(parseInt(u || '0', 10) + 1), { expirationTtl: ttl }),
    env.RATE_LIMIT.put(globalKey, String(parseInt(g || '0', 10) + 1), { expirationTtl: ttl }),
  ]);
}

async function handleChat(request, env) {
  const origin = request.headers.get('Origin') || '';
  const corsHeaders = cors(origin, env);

  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (body.messages.length > 24) {
    body.messages = body.messages.slice(-24);
  }

  const userId = (request.headers.get('X-CityHUB-User') || 'anon').slice(0, 64);
  const rate = await checkRateLimit(env, userId);
  if (!rate.ok) {
    return new Response(JSON.stringify({
      error: 'rate_limit',
      reason: rate.reason,
      message: rate.reason === 'global'
        ? 'CityHUB AI на сегодня перегружен — попробуй завтра'
        : 'Ты исчерпал дневной лимит — попробуй завтра',
    }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const payload = {
    model: body.model || MODEL,
    max_tokens: Math.min(body.max_tokens || MAX_TOKENS, 1500),
    system: body.system || '',
    messages: body.messages,
    stream: true,
  };

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const errTxt = await upstream.text().catch(() => '');
    return new Response(JSON.stringify({
      error: 'upstream',
      status: upstream.status,
      body: errTxt.slice(0, 300),
    }), {
      status: upstream.status === 401 ? 500 : 502, // hide bad key as 500
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Bump rate limit AFTER successful upstream
  await bumpRateLimit(env, userId);

  // Pipe SSE stream back to client
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin') || '';
      return new Response(null, { status: 204, headers: cors(origin, env) });
    }

    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    if (url.pathname === '/api/health') {
      const origin = request.headers.get('Origin') || '';
      return new Response(JSON.stringify({
        ok: true,
        model: MODEL,
        time: new Date().toISOString(),
      }), {
        status: 200,
        headers: { ...cors(origin, env), 'Content-Type': 'application/json' },
      });
    }

    return new Response('CityHUB API · use /api/chat', { status: 200 });
  },
};
