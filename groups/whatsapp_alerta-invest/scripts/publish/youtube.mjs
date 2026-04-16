#!/usr/bin/env node
// Publish YouTube Shorts — uploads pre-generated cinematic video
// Env: YOUTUBE_OAUTH_TOKEN
// Input (stdin): {
//   videoPath: string,         // absolute path to MP4 (1080×1920, 15s) from generate-video.mjs
//   assets?: Array<{ ticker, nome, indice, tipo, indicador, preco }>,
//   sessionLabel?: string,
//   type?: 'signal' | 'promo' | 'news',
//   headline?: string,
//   title?: string,            // full override for video title (≤100 chars)
//   description?: string,      // full override for description
//   tags?: string[],
// }

import { readFileSync, statSync, unlinkSync } from 'fs';

const OAUTH_TOKEN = process.env.YOUTUBE_OAUTH_TOKEN;

if (!OAUTH_TOKEN) {
  console.log(JSON.stringify({ error: 'Missing YOUTUBE_OAUTH_TOKEN' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { videoPath, assets = [], sessionLabel = '', type = 'signal', headline } = input;

if (!videoPath) {
  console.log(JSON.stringify({ error: 'videoPath is required' }));
  process.exit(1);
}

const FLAGS = {
  ibov:'🇧🇷', sp500:'🇺🇸', tsx:'🇨🇦', ipc:'🇲🇽',
  ftse100:'🇬🇧', dax:'🇩🇪', cac40:'🇫🇷', aex:'🇳🇱',
  smi:'🇨🇭', omx:'🇸🇪', ibex35:'🇪🇸', jse:'🇿🇦',
  nikkei225:'🇯🇵', hsi:'🇭🇰', nsei:'🇮🇳', kospi:'🇰🇷',
  asx200:'🇦🇺', jkse:'🇮🇩', klse:'🇲🇾', set50:'🇹🇭',
};

function buildTitle() {
  if (input.title) return input.title.slice(0, 100);

  const label = sessionLabel || 'Global Markets';
  if (type === 'signal') {
    const top = assets.slice(0, 3).map(a => {
      const dir = a.tipo === 'bullish' ? '▲' : '▼';
      return `${dir} $${a.ticker}`;
    }).join(' · ');
    return `${assets.length} Signals — ${label} | ${top}`.slice(0, 100);
  }
  if (type === 'news') return (headline || `Market Update — ${label}`).slice(0, 100);
  return `Flago — Technical Signals Across 20 Global Markets`.slice(0, 100);
}

function buildDescription() {
  if (input.description) return input.description;

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const label = sessionLabel || 'global markets';

  if (type === 'signal') {
    const lines = assets.slice(0, 6).map(a => {
      const flag = FLAGS[a.indice?.toLowerCase()] || '🌐';
      const dir  = a.tipo === 'bullish' ? '▲ BULLISH' : a.tipo === 'bearish' ? '▼ BEARISH' : '● NEUTRAL';
      const ind  = (a.indicador || '').toUpperCase();
      const price = (a.preco && a.preco !== 0)
        ? ` — ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(a.preco)}`
        : '';
      return `${flag} $${a.ticker} (${a.nome || ''}) · ${dir} · ${ind}${price}`;
    });
    return [
      `Technical signals across ${label} — ${today}`,
      '',
      lines.join('\n'),
      assets.length > 6 ? `+${assets.length - 6} more signals tracked` : '',
      '',
      'Track global market signals with Flago → https://flago.io',
      '14-day free trial. No credit card required.',
      '',
      '#Shorts #StockMarket #TechnicalAnalysis #Trading #Investing #GlobalMarkets #Signals #Flago',
    ].filter(Boolean).join('\n');
  }

  if (type === 'news') {
    return [
      headline || 'Market update.',
      '',
      'Stay ahead of global market moves with technical signals from Flago → https://flago.io',
      '',
      '#Shorts #Finance #Markets #StockMarket #TechnicalAnalysis #Investing #Flago',
    ].join('\n');
  }

  return [
    '20 global markets. One signal.',
    '',
    'Flago monitors technical signals across Asia, Europe, Africa and the Americas — MACD, RSI, OBV and more.',
    'Get alerts via WhatsApp, email or push. Start free → https://flago.io',
    '',
    '#Shorts #FinTech #Investing #StockMarket #TechnicalAnalysis #GlobalMarkets #Flago',
  ].join('\n');
}

function buildTags() {
  if (input.tags?.length) return input.tags.slice(0, 15);
  const base = ['Flago', 'TechnicalAnalysis', 'StockMarket', 'Investing', 'GlobalMarkets', 'Signals', 'Shorts'];
  if (type === 'signal') {
    const tickers = assets.slice(0, 4).map(a => a.ticker).filter(Boolean);
    return [...base, ...tickers, 'Trading'].slice(0, 15);
  }
  return [...base, 'Finance', 'Trading'].slice(0, 15);
}

try {
  const videoSize = statSync(videoPath).size;
  const title     = buildTitle();
  const description = buildDescription();
  const tags      = buildTags();

  // Initiate resumable upload
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OAUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': videoSize.toString(),
      },
      body: JSON.stringify({
        snippet: {
          title,
          description,
          tags,
          categoryId: '22',  // People & Blogs (fits financial content well)
          defaultLanguage: 'en',
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  );

  if (!initRes.ok) throw new Error(`Upload init failed: ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('No upload URL returned');

  // Upload video bytes
  const videoBuffer = readFileSync(videoPath);
  const uploadRes   = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': videoSize.toString(),
    },
    body: videoBuffer,
  });

  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(uploadData.error?.message || JSON.stringify(uploadData));

  const videoId = uploadData.id;
  console.log(JSON.stringify({
    success: true,
    postId: videoId,
    url: `https://youtube.com/shorts/${videoId}`,
    platform: 'youtube',
    title,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'youtube' }));
  process.exit(1);
}
