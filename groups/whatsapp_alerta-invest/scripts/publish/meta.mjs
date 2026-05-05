#!/usr/bin/env node
// Publish to Instagram Feed + Facebook Page via Meta Graph API
// Env: META_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ACCOUNT_ID, FACEBOOK_PAGE_ID
// Input (stdin): {
//   imageUrl: string,          // Cloudinary square PNG URL (Instagram feed)
//   assets?: Array<{ ticker, nome, indice, tipo, indicador, preco }>,
//   sessionLabel?: string,
//   type?: 'signal' | 'promo' | 'news',
//   headline?: string,         // promo/news: main copy line
//   caption?: string,          // full override — skips auto-generation
//   hashtags?: string[],       // appended after caption (auto-generated if omitted)
// }

import { readFileSync } from 'fs';

const TOKEN   = process.env.META_ACCESS_TOKEN;
const IG_ID   = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const FB_PAGE = process.env.FACEBOOK_PAGE_ID;
const BASE    = 'https://graph.facebook.com/v20.0';

if (!TOKEN || !IG_ID) {
  console.log(JSON.stringify({ error: 'Missing META_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { imageUrl, assets = [], sessionLabel = '', type = 'signal', headline } = input;

const FLAGS = {
  ibov:'🇧🇷', sp500:'🇺🇸', tsx:'🇨🇦', ipc:'🇲🇽',
  ftse100:'🇬🇧', dax:'🇩🇪', cac40:'🇫🇷', aex:'🇳🇱',
  smi:'🇨🇭', omx:'🇸🇪', ibex35:'🇪🇸', jse:'🇿🇦',
  nikkei225:'🇯🇵', hsi:'🇭🇰', nsei:'🇮🇳', kospi:'🇰🇷',
  asx200:'🇦🇺', jkse:'🇮🇩', klse:'🇲🇾', set50:'🇹🇭',
};

function buildCaption() {
  if (input.caption) return input.caption;

  if (type === 'signal') {
    const lines = assets.slice(0, 6).map(a => {
      const flag = FLAGS[a.indice?.toLowerCase()] || '🌐';
      const dir  = a.tipo === 'bullish' ? '▲' : a.tipo === 'bearish' ? '▼' : '●';
      return `${flag} $${a.ticker} ${dir} ${(a.indicador || '').toUpperCase()}`;
    });
    const label = sessionLabel ? `${sessionLabel} session` : 'right now';
    return [
      `${assets.length} signals firing — ${label}`,
      '',
      lines.join('\n'),
      '',
      'Track them all → link in bio',
    ].join('\n');
  }

  if (type === 'news') {
    return [
      headline || 'Market update.',
      '',
      'Full context and related signals → link in bio',
    ].join('\n');
  }

  // promo
  return [
    headline || '20 global markets. One signal.',
    '',
    'Technical signals from Asia to the Americas — start free → link in bio',
  ].join('\n');
}

function buildHashtags() {
  if (input.hashtags?.length) return input.hashtags;

  const base = ['Flago', 'TechnicalAnalysis', 'StockMarket', 'Investing', 'GlobalMarkets'];
  if (type === 'signal') {
    const tickers = assets.slice(0, 3).map(a => a.ticker).filter(Boolean);
    const indicators = [...new Set(assets.map(a => a.indicador).filter(Boolean))].slice(0, 2);
    return [...base, ...tickers, ...indicators, 'Trading', 'Signals'];
  }
  if (type === 'news') return [...base, 'MarketNews', 'Finance', 'Economics'];
  return [...base, 'FinTech', 'Finance', 'Trading'];
}

const caption   = buildCaption();
const hashtags  = buildHashtags();
const fullCaption = `${caption}\n\n${hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}`;

async function post(url, body) {
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: TOKEN }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data;
}

const results = {};

// ── Page Access Token (required for Facebook Page posts) ─────────────────────
let PAGE_TOKEN = TOKEN;
if (FB_PAGE) {
  try {
    const pagesRes = await fetch(`${BASE}/me/accounts?access_token=${TOKEN}`);
    const pages = await pagesRes.json();
    const page = pages.data?.find(p => p.id === FB_PAGE);
    if (page?.access_token) PAGE_TOKEN = page.access_token;
  } catch {}
}

// ── Instagram feed ───────────────────────────────────────────────────────────
try {
  const container = await post(`${BASE}/${IG_ID}/media`, {
    image_url: imageUrl,
    caption: fullCaption,
  });
  if (!container.id) throw new Error('No container ID');

  await new Promise(r => setTimeout(r, 5000));

  const statusRes = await fetch(`${BASE}/${container.id}?fields=status_code&access_token=${TOKEN}`);
  const status    = await statusRes.json();
  if (status.status_code && status.status_code !== 'FINISHED') {
    throw new Error(`Container not ready: ${status.status_code}`);
  }

  const published = await post(`${BASE}/${IG_ID}/media_publish`, { creation_id: container.id });

  // Fetch permalink — numeric media ID is not a valid public URL
  const permalinkRes = await fetch(`${BASE}/${published.id}?fields=permalink&access_token=${TOKEN}`);
  const permalinkData = await permalinkRes.json();
  const permalink = permalinkData.permalink || `https://www.instagram.com/p/${published.id}/`;

  results.instagram = { success: true, postId: published.id, url: permalink };
} catch (err) {
  results.instagram = { success: false, error: err.message };
}

// ── Facebook Page ────────────────────────────────────────────────────────────
if (FB_PAGE) {
  try {
    const fb = await fetch(`${BASE}/${FB_PAGE}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: imageUrl, caption: fullCaption, published: true, access_token: PAGE_TOKEN }),
    }).then(r => r.json());
    if (fb.error) throw new Error(fb.error.message);
    const postId = fb.post_id || fb.id;
    results.facebook = { success: true, postId, url: `https://facebook.com/${postId}` };
  } catch (err) {
    results.facebook = { success: false, error: err.message };
  }
} else {
  results.facebook = { success: false, error: 'FACEBOOK_PAGE_ID not set — skipped' };
}

const anyOk = Object.values(results).some(r => r.success);
console.log(JSON.stringify({ success: anyOk, platform: 'meta', results }));
if (!anyOk) process.exit(1);
