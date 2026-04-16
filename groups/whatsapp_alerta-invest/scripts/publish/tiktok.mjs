#!/usr/bin/env node
// Publish video to TikTok via Content Posting API v2 (PULL_FROM_URL)
// Env: TIKTOK_ACCESS_TOKEN, TIKTOK_USERNAME (for profile URL fallback)
// Input (stdin): {
//   videoUrl: string,          // Cloudinary MP4 URL (1080×1920, 15s)
//   assets?: Array<{ ticker, nome, indice, tipo, indicador }>,
//   sessionLabel?: string,
//   type?: 'signal' | 'promo' | 'news',
//   headline?: string,
//   caption?: string,          // full override
// }
//
// TikTok captions: short hook format, ≤ 2200 chars, no external links allowed.

import { readFileSync } from 'fs';

const TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const BASE  = 'https://open.tiktokapis.com/v2';

if (!TOKEN) {
  console.log(JSON.stringify({ error: 'Missing TIKTOK_ACCESS_TOKEN' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { videoUrl, assets = [], sessionLabel = '', type = 'signal', headline } = input;

if (!videoUrl) {
  console.log(JSON.stringify({ error: 'videoUrl is required (Cloudinary MP4 URL)' }));
  process.exit(1);
}

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
    // Hook → signal list → soft CTA (no external links on TikTok)
    const top  = assets.slice(0, 3);
    const lines = top.map(a => {
      const flag = FLAGS[a.indice?.toLowerCase()] || '🌐';
      const dir  = a.tipo === 'bullish' ? '📈' : a.tipo === 'bearish' ? '📉' : '➡️';
      return `${flag} $${a.ticker} ${dir}`;
    });
    const label = sessionLabel || 'global markets';
    return [
      `${assets.length} technical signals just fired across ${label} 👀`,
      '',
      lines.join('\n'),
      '',
      '#TechnicalAnalysis #StockMarket #Trading #GlobalMarkets #Signals #Investing #Flago',
    ].join('\n');
  }

  if (type === 'news') {
    return [
      headline || 'Markets are moving.',
      '',
      'Here's what the technicals are showing right now 👇',
      '',
      '#Markets #Finance #StockMarket #TechnicalAnalysis #Investing #Flago',
    ].join('\n');
  }

  // promo
  return [
    '20 global markets. One signal. 🌍',
    '',
    'Technical alerts from Asia to the Americas — all in one place.',
    '',
    '#FinTech #Investing #StockMarket #TechnicalAnalysis #Trading #Flago',
  ].join('\n');
}

async function postJson(url, body) {
  const res  = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || (data.error?.code && data.error.code !== 'ok')) {
    throw new Error(data.error?.message || JSON.stringify(data));
  }
  return data;
}

try {
  const caption = buildCaption().slice(0, 2200);

  // Initialize video post (PULL_FROM_URL — TikTok fetches from Cloudinary)
  const init = await postJson(`${BASE}/post/publish/video/init/`, {
    post_info: {
      title: caption,
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      video_url: videoUrl,
    },
    post_mode: 'DIRECT_POST',
    media_type: 'VIDEO',
  });

  const publishId = init.data?.publish_id;
  if (!publishId) throw new Error('No publish_id returned');

  // Poll for completion
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const statusData = await postJson(`${BASE}/post/publish/status/fetch/`, { publish_id: publishId });
    const status = statusData.data?.status;
    if (status === 'PUBLISH_COMPLETE') {
      const url = `https://www.tiktok.com/@${process.env.TIKTOK_USERNAME || 'me'}`;
      console.log(JSON.stringify({ success: true, postId: publishId, url, platform: 'tiktok' }));
      process.exit(0);
    }
    if (status === 'FAILED') throw new Error(`TikTok publish failed: ${JSON.stringify(statusData.data)}`);
  }
  throw new Error('TikTok publish timed out after 60s');
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'tiktok' }));
  process.exit(1);
}
