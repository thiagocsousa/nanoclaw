#!/usr/bin/env node
// Publish to LinkedIn personal profile via LinkedIn REST API (w_member_social)
// Posts as the authenticated member; mentions Flago company page in text.
// Env: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_REFRESH_TOKEN
//   OR LINKEDIN_ACCESS_TOKEN (static token fallback — expires in 60 days)
// Input (stdin): {
//   squarePath: string,        // absolute path to square PNG (1080×1080)
//   assets?: Array<{ ticker, nome, indice, tipo, indicador, preco }>,
//   sessionLabel?: string,
//   type?: 'signal' | 'promo' | 'news',
//   headline?: string,
//   text?: string,             // full override — skips auto-generation
// }

import { readFileSync } from 'fs';

const CLIENT_ID      = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET  = process.env.LINKEDIN_CLIENT_SECRET;
const REFRESH_TOKEN  = process.env.LINKEDIN_REFRESH_TOKEN;
const STATIC_TOKEN   = process.env.LINKEDIN_ACCESS_TOKEN;

if (!REFRESH_TOKEN && !STATIC_TOKEN) {
  console.log(JSON.stringify({ error: 'Missing LINKEDIN_REFRESH_TOKEN (or LINKEDIN_ACCESS_TOKEN)', platform: 'linkedin' }));
  process.exit(1);
}

const API          = 'https://api.linkedin.com/rest';
const HEADERS_BASE = { 'LinkedIn-Version': '202502', 'X-Restli-Protocol-Version': '2.0.0' };

async function getAccessToken() {
  if (!REFRESH_TOKEN || !CLIENT_ID || !CLIENT_SECRET) return STATIC_TOKEN;
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (data.error === 'invalid_grant' || data.error === 'unauthorized_client') {
    console.log(JSON.stringify({ error: 'LinkedIn refresh token expired. Re-authorization required.', needsReauth: true, platform: 'linkedin' }));
    process.exit(2);
  }
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

const TOKEN = await getAccessToken();
const AUTH  = { ...HEADERS_BASE, Authorization: `Bearer ${TOKEN}` };

// Resolve person URN (from env or OpenID Connect userinfo)
let personId = process.env.LINKEDIN_PERSON_ID || '';
if (!personId) {
  const uiRes = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (uiRes.ok) { const ui = await uiRes.json(); personId = ui.sub || ''; }
}
if (!personId) {
  console.log(JSON.stringify({ error: 'Could not resolve LinkedIn person ID. Set LINKEDIN_PERSON_ID in .env.', platform: 'linkedin' }));
  process.exit(1);
}
const AUTHOR = `urn:li:person:${personId}`;

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { squarePath, assets = [], sessionLabel = '', type = 'signal', headline } = input;

const FLAGS = {
  ibov:'🇧🇷', sp500:'🇺🇸', tsx:'🇨🇦', ipc:'🇲🇽',
  ftse100:'🇬🇧', dax:'🇩🇪', cac40:'🇫🇷', aex:'🇳🇱',
  smi:'🇨🇭', omx:'🇸🇪', ibex35:'🇪🇸', jse:'🇿🇦',
  nikkei225:'🇯🇵', hsi:'🇭🇰', nsei:'🇮🇳', kospi:'🇰🇷',
  asx200:'🇦🇺', jkse:'🇮🇩', klse:'🇲🇾', set50:'🇹🇭',
};

function buildText() {
  if (input.text) return input.text;

  const label = sessionLabel || 'Global Markets';

  if (type === 'signal') {
    const lines = assets.slice(0, 5).map(a => {
      const flag = FLAGS[a.indice?.toLowerCase()] || '🌐';
      const dir  = a.tipo === 'bullish' ? '▲ Bullish' : '▼ Bearish';
      const ind  = (a.indicador || '').toUpperCase();
      const price = (a.preco && a.preco !== 0)
        ? ` · ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(a.preco)}`
        : '';
      return `${flag} $${a.ticker} — ${dir} · ${ind}${price}`;
    });
    return [
      `${assets.length} technical signals firing across ${label} right now.`,
      '',
      lines.join('\n'),
      assets.length > 5 ? `+${assets.length - 5} more tracked across 20 global indices.` : '',
      '',
      'Flago monitors MACD, RSI, OBV and more across 1,800+ assets — 20 global markets.',
      '14-day free trial. Informational signals. No financial advice.',
      '',
      '🔗 flago.io | Follow: linkedin.com/company/flago-io',
      '',
      '#TechnicalAnalysis #StockMarket #GlobalMarkets #Trading #Investing #Signals #Flago',
    ].filter(Boolean).join('\n');
  }

  if (type === 'news') {
    return [
      headline || `Market Update — ${label}`,
      '',
      'Stay ahead of global market moves with technical signals from Flago.',
      'Informational signals. No financial advice.',
      '',
      '🔗 flago.io | linkedin.com/company/flago-io',
      '',
      '#Markets #Finance #GlobalMarkets #TechnicalAnalysis #Investing #Flago',
    ].join('\n');
  }

  // promo
  return [
    '20 global markets. 10 technical indicators. 1,800+ assets monitored.',
    '',
    'Flago sends you actionable signals — MACD, RSI, OBV and more — across Asia, Europe, Africa and the Americas.',
    '',
    'WhatsApp, email or push. Start free for 14 days.',
    'Informational signals. No financial advice.',
    '',
    '🔗 flago.io',
    '',
    '#FinTech #Investing #TechnicalAnalysis #StockMarket #GlobalMarkets #Flago',
  ].join('\n');
}

try {
  const text = buildText();

  // Upload image if provided
  let imageUrn = null;
  if (squarePath) {
    // Initialize upload
    const initRes = await fetch(`${API}/images?action=initializeUpload`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ initializeUploadRequest: { owner: AUTHOR } }),
    });
    if (!initRes.ok) throw new Error(`Image upload init failed: ${await initRes.text()}`);
    const { value: { uploadUrl, image } } = await initRes.json();

    // Upload bytes
    const imageBuffer = readFileSync(squarePath);
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${TOKEN}` },
      body: imageBuffer,
    });
    if (!uploadRes.ok) throw new Error(`Image upload failed: ${await uploadRes.text()}`);
    imageUrn = image;
  }

  // Build post body
  const postBody = {
    author: AUTHOR,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (imageUrn) {
    postBody.content = {
      media: {
        altText: `Flago — ${sessionLabel || 'Global Market Signals'}`,
        id: imageUrn,
      },
    };
  }

  // Create post
  const postRes = await fetch(`${API}/posts`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(postBody),
  });

  if (!postRes.ok) throw new Error(`Post failed: ${await postRes.text()}`);

  const postId = postRes.headers.get('x-restli-id') || 'unknown';
  const encodedId = encodeURIComponent(postId);

  console.log(JSON.stringify({
    success: true,
    postId,
    url: `https://www.linkedin.com/feed/update/${encodedId}`,
    platform: 'linkedin',
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'linkedin' }));
  process.exit(1);
}
