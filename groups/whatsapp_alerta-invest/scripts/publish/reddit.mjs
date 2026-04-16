#!/usr/bin/env node
// Post to Reddit — organic text posts in finance subreddits
// Env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
//
// Input (stdin): {
//   assets?: Array<{ ticker, nome, indice, tipo, indicador, preco }>,
//   sessionLabel?: string,
//   type?: 'signal' | 'promo' | 'news',
//   headline?: string,       // news: real headline from source
//   subline?: string,        // news: context paragraph
//   subreddits?: string[],   // default: derived from session/assets
// }
//
// Content strategy:
//   signal — "Here's what's showing up on the technicals" framing, genuine analysis
//   news   — editorial observation tied to a real headline, no promo tone in title
//   promo  — community question / discussion starter, mention product organically
//
// No r/ prefix needed in subreddit names.
// Posts to each sub separately; continues on failure (logs per sub).

import { readFileSync } from 'fs';

const CLIENT_ID     = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const USERNAME      = process.env.REDDIT_USERNAME;
const PASSWORD      = process.env.REDDIT_PASSWORD;

if (!CLIENT_ID || !CLIENT_SECRET || !USERNAME || !PASSWORD) {
  console.log(JSON.stringify({ error: 'Missing Reddit credentials' }));
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

// Default subreddits per session region (inferred from assets' indices)
const REGION_SUBS = {
  americas: ['investing', 'stocks', 'StockMarket', 'SecurityAnalysis'],
  europe:   ['investing', 'EuropeanFIRE', 'UKInvesting', 'GERFinance'],
  asia:     ['investing', 'IndiaInvestments', 'AusFinance', 'JapanFinance'],
  global:   ['investing', 'stocks', 'GlobalMarkets', 'SecurityAnalysis'],
};

function inferRegion(assets) {
  const indices = assets.map(a => a.indice?.toLowerCase() || '');
  if (indices.some(i => ['sp500','tsx','ipc','ibov'].includes(i))) return 'americas';
  if (indices.some(i => ['ftse100','dax','cac40','aex','smi','omx','ibex35','jse'].includes(i))) return 'europe';
  if (indices.some(i => ['nikkei225','hsi','nsei','kospi','asx200','jkse','klse','set50'].includes(i))) return 'asia';
  return 'global';
}

function buildPost() {
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  if (type === 'signal') {
    const label = sessionLabel || 'global markets';
    const title = `Technical signals across ${label} — ${today}`;

    const lines = assets.slice(0, 6).map(a => {
      const flag  = FLAGS[a.indice?.toLowerCase()] || '🌐';
      const dir   = a.tipo === 'bullish' ? '▲ Bullish' : a.tipo === 'bearish' ? '▼ Bearish' : '● Neutral';
      const ind   = (a.indicador || '').toUpperCase();
      const price = (a.preco && a.preco !== 0) ? ` — ${new Intl.NumberFormat('en-US',{minimumFractionDigits:2}).format(a.preco)}` : '';
      return `- ${flag} **$${a.ticker}** (${a.nome || a.indice}) — ${dir} · ${ind}${price}`;
    });
    const extra = assets.length > 6 ? `\n*+${assets.length - 6} more signals across open markets.*` : '';

    const body = [
      `Sharing what's showing up on the technicals across ${label} right now.`,
      '',
      lines.join('\n'),
      extra,
      '',
      'Using MACD, RSI, OBV and a few others. All signals from [Flago](https://flago.io) — free to check.',
      '',
      '*Informational signals. No finance advice.*',
    ].join('\n');

    return { title, body };
  }

  if (type === 'news') {
    const h = headline || 'Market update';
    const s = subline  || '';
    // Title is the real headline — no brand mention
    const title = h.length > 300 ? h.slice(0, 297) + '…' : h;
    const signalLines = assets.slice(0, 3).map(a => {
      const flag = FLAGS[a.indice?.toLowerCase()] || '🌐';
      const dir  = a.tipo === 'bullish' ? '▲' : '▼';
      return `- ${flag} $${a.ticker} showing ${dir} ${(a.indicador||'').toUpperCase()}`;
    });
    const body = [
      s || '',
      '',
      signalLines.length > 0 ? '**Related signals firing right now:**' : '',
      ...signalLines,
      '',
      'Full context and more signals at [flago.io](https://flago.io).',
    ].filter(Boolean).join('\n');

    return { title, body };
  }

  if (type === 'promo') {
    // Community-oriented question — gets discussion, not downvotes
    const templates = [
      {
        title: 'What technical indicators do you actually use for global index trading?',
        body:  `I've been tracking signals across 20 indices (S&P, DAX, Nikkei, IBOV, etc.) and curious what others watch.\n\nI built [Flago](https://flago.io) to automate this — it monitors MACD, RSI, OBV and picks the best-performing indicator per asset historically. Happy to discuss methodology.\n\nWhat's your approach for global markets?`,
      },
      {
        title: 'How do you keep track of signals across multiple global markets simultaneously?',
        body:  `Struggling with this for a while — Asia opens, then Europe, then Americas. By the time you're watching one region you've missed the others.\n\nBuilt something to handle this: [Flago](https://flago.io) monitors 20 indices and sends alerts (WhatsApp, email, push) when technical signals fire. 14-day free trial if you want to test it.\n\nCurious how others solve this.`,
      },
      {
        title: 'Anyone else track both MACD and RSI across international indices? Sharing my setup.',
        body:  `Been building a systematic approach to cross-market technical analysis. Main challenge is getting timely data across time zones without watching charts all day.\n\nCurrent setup uses [Flago](https://flago.io) for automated signal detection across 20 markets — it covers Asia, Europe, Africa and the Americas in one dashboard.\n\nWhat indicators do you find most reliable across different market structures?`,
      },
    ];
    const idx = new Date().getDay() % templates.length;
    return templates[idx];
  }

  return { title: headline || 'Market update', body: subline || '' };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function getToken() {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Flago/1.0',
    },
    body: `grant_type=password&username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}&scope=submit`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Reddit auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function submitPost(token, subreddit, title, text) {
  const params = new URLSearchParams({
    sr: subreddit, title, kind: 'self', text,
    resubmit: 'true', nsfw: 'false', spoiler: 'false',
  });
  const res = await fetch('https://oauth.reddit.com/api/submit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Flago/1.0',
    },
    body: params,
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || JSON.stringify(data));
  // Extract post URL from reddit's quirky response format
  const url = data?.jquery?.find?.(r =>
    Array.isArray(r) && r.some(x => typeof x === 'string' && x.includes('reddit.com/r/'))
  )?.[3]?.[0] || data?.data?.url || `https://reddit.com/r/${subreddit}`;
  return url;
}

// ── Post to each subreddit ────────────────────────────────────────────────────

const region     = inferRegion(assets);
const subreddits = input.subreddits?.length ? input.subreddits : REGION_SUBS[region];
const { title, body } = buildPost();

const results = [];
try {
  const token = await getToken();
  for (const sub of subreddits) {
    try {
      const url = await submitPost(token, sub, title, body);
      results.push({ subreddit: sub, success: true, url });
    } catch (err) {
      results.push({ subreddit: sub, success: false, error: err.message });
    }
    // Brief pause between submissions to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }
  const anyOk = results.some(r => r.success);
  console.log(JSON.stringify({ success: anyOk, platform: 'reddit', type, title, results }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'reddit' }));
  process.exit(1);
}
