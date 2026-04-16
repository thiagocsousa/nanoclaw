#!/usr/bin/env node
// Send Market News digest email to all active Flago users
// Env: FLAGO_AGENT_API_KEY, FLAGO_CF_BASE_URL (optional, defaults to prod)
//
// Input (stdin): {
//   items: Array<{ headline: string, subline?: string }>,
//   session_label?: string,   // e.g. "Europe Mid"
// }
//
// Output (stdout): { ok: true, sent: number } | { error: string }

const CF_BASE = process.env.FLAGO_CF_BASE_URL ||
  'https://southamerica-east1-alerta-invest-brasil.cloudfunctions.net';

const API_KEY = process.env.FLAGO_AGENT_API_KEY;

if (!API_KEY) {
  console.log(JSON.stringify({ error: 'Missing FLAGO_AGENT_API_KEY' }));
  process.exit(1);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw);
    const { items, session_label } = input;

    if (!Array.isArray(items) || items.length === 0) {
      console.log(JSON.stringify({ error: 'items array is required and must not be empty' }));
      process.exit(1);
    }

    const payload = { items, session_label: session_label || null };

    const res = await fetch(`${CF_BASE}/enviar_news_digest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.log(JSON.stringify({ error: `CF responded ${res.status}`, detail: body }));
      process.exit(1);
    }

    console.log(JSON.stringify(body));
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
});
