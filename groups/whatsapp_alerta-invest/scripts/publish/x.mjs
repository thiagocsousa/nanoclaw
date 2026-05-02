#!/usr/bin/env node
// Post to X/Twitter — text-first, organic trader voice
// Env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//
// Input (stdin): {
//   assets?: Array<{ ticker, nome, indice, tipo, indicador, preco }>,
//   sessionLabel?: string,
//   type?: 'signal' | 'promo' | 'news',
//   headline?: string,       // news: editorial headline; promo: override copy
//   subline?: string,        // news: context line
//   landscapePath?: string,  // optional supporting image (landscape 1200×675)
//   text?: string,           // full override — skips auto-generation
// }
//
// Content strategy:
//   signal — concise alert list with flag emojis, reads like a trader sharing intel
//   promo  — 1st-person discovery tone, no hard sell, 1×/week max
//   news   — editorial observation tied to a real signal, link for context

import { createHmac } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const API_KEY     = process.env.X_API_KEY;
const API_SECRET  = process.env.X_API_SECRET;
const ACCESS_TOKEN  = process.env.X_ACCESS_TOKEN;
const ACCESS_SECRET = process.env.X_ACCESS_SECRET;

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_SECRET) {
  console.log(JSON.stringify({ error: 'Missing X OAuth credentials' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { assets = [], sessionLabel = '', type = 'signal', headline, subline } = input;

const FLAGS = {
  ibov:'🇧🇷', sp500:'🇺🇸', tsx:'🇨🇦', ipc:'🇲🇽',
  ftse100:'🇬🇧', dax:'🇩🇪', cac40:'🇫🇷', aex:'🇳🇱',
  smi:'🇨🇭', omx:'🇸🇪', ibex35:'🇪🇸', jse:'🇿🇦',
  nikkei225:'🇯🇵', hsi:'🇭🇰', nsei:'🇮🇳', kospi:'🇰🇷',
  asx200:'🇦🇺', jkse:'🇮🇩', klse:'🇲🇾', set50:'🇹🇭',
};

function buildText() {
  // Full override
  if (input.text) return input.text;

  if (type === 'signal') {
    // Show top 4 signals as concise alert lines — reads like a trader's note
    const top = assets.slice(0, 4);
    const lines = top.map(a => {
      const flag  = FLAGS[a.indice?.toLowerCase()] || '🌐';
      const dir   = a.tipo === 'bullish' ? '▲ Bullish' : a.tipo === 'bearish' ? '▼ Bearish' : '●';
      const ind   = (a.indicador || '').toUpperCase();
      return `${flag} ${a.ticker} ${dir} · ${ind}`;
    });
    const extra = assets.length > 4 ? `+${assets.length - 4} more signals firing` : '';
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD — unique per day
    const timeStr = now.toISOString().slice(0, 16).replace('T', ' ');
    // Vary the opening line per session to avoid structural pattern detection
    const OPENERS = [
      `${sessionLabel} — signals firing:`,
      `${dateStr} · ${sessionLabel}:`,
      `${sessionLabel} update:`,
      `Markets now · ${sessionLabel}:`,
      `${sessionLabel} signals:`,
      `Active signals · ${sessionLabel}:`,
    ];
    const opener = OPENERS[now.getUTCHours() % OPENERS.length];
    return [
      opener,
      '',
      ...lines,
      extra,
      '',
      `${timeStr} UTC · flago.io`,
      'Informational signals. No financial advice.',
    ].filter(l => l !== undefined && !(l === '' && !extra)).join('\n');
  }

  if (type === 'news') {
    // Editorial tone: observation first, then context, soft link
    const h = headline || 'Markets moving.';
    const s = subline  || '';
    return [
      h,
      s ? `\n${s}` : '',
      '',
      'Signals across 20 global indices → flago.io',
    ].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  if (type === 'promo') {
    // 1st-person discovery voice — rotate through a few templates by day of week
    const templates = [
      'One thing I wish I had earlier: a single dashboard that surfaces technical signals across all major global markets simultaneously.\n\nBuilt exactly that → flago.io',
      'Most traders watch one market. The signal is usually in another one.\n\nFlago tracks 20 indices at once so you don\'t miss it → flago.io',
      'MACD, RSI, OBV — across 20 global markets, automatically.\n\nNo setup. No noise. Just the signals that matter → flago.io',
      'The Asia open, the Europe open, the Americas open. Three different sessions, same dashboard.\n\nflago.io',
    ];
    const idx = new Date().getDay() % templates.length;
    return headline || templates[idx];
  }

  return input.text || '';
}

// ── OAuth 1.0a ───────────────────────────────────────────────────────────────

function oauthSign(method, url, extraParams = {}) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const ts    = Math.floor(Date.now() / 1000).toString();
  const oauthParams = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts,
    oauth_token:            ACCESS_TOKEN,
    oauth_version:          '1.0',
    ...extraParams,
  };
  const all = Object.keys(oauthParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join('&');
  const base  = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(all)].join('&');
  const key   = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(ACCESS_SECRET)}`;
  const sig   = createHmac('sha1', key).update(base).digest('base64');
  oauthParams.oauth_signature = sig;
  return 'OAuth ' + Object.keys(oauthParams)
    .filter(k => k.startsWith('oauth_'))
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');
}

// ── Post ─────────────────────────────────────────────────────────────────────

try {
  const text    = buildText();
  const tweetUrl = 'https://api.twitter.com/2/tweets';

  const res  = await fetch(tweetUrl, {
    method: 'POST',
    headers: { Authorization: oauthSign('POST', tweetUrl), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = { status: res.status, headers: Object.fromEntries(res.headers), body: data, timestamp: new Date().toISOString() };
    mkdirSync('/workspace/group/tmp', { recursive: true });
    writeFileSync('/workspace/group/tmp/x-last-error.json', JSON.stringify(detail, null, 2));
    throw new Error(JSON.stringify(detail));
  }

  const id = data.data?.id;
  console.log(JSON.stringify({
    success:  true,
    postId:   id,
    url:      `https://x.com/i/web/status/${id}`,
    platform: 'x',
    type,
    text,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'x' }));
  process.exit(1);
}
