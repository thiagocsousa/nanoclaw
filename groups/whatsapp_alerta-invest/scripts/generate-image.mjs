#!/usr/bin/env node
// Generate Flago social creative — multi-format, official brand palette
// Input (stdin): {
//   session: 'open' | 'mid',
//   sessionLabel: string,          // e.g. "European Markets · Open"
//   format?: 'square'|'story'|'landscape',  // default: 'square'
//   assets: Array<{
//     ticker: string,              // without suffix, e.g. "AAPL"
//     nome: string,                // company name from API
//     indice: string,              // e.g. "ftse100", "sp500"
//     tipo: 'bullish'|'bearish',
//     indicador: string,           // e.g. "MACD", "RSI"
//     preco: number|null,          // null or 0 → renders as "—"
//   }>,
//   outputPath?: string,
//   caption?: string,
// }
//
// Formats:
//   square    → 1080×1080  (Instagram feed, Facebook)
//   story     → 1080×1920  (Stories, TikTok, YouTube Shorts)
//   landscape → 1200×675   (X/Twitter)

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CHROMIUM =
  process.env.AGENT_BROWSER_EXECUTABLE_PATH ||
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  '/usr/bin/chromium';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const {
  session = 'open',
  sessionLabel = 'Markets',
  format = 'square',
  assets = [],
  outputPath,
  capturedAt,           // ISO string from API fetched_at — shown as "captured at HH:MM UTC"
  type = assets.length === 0 ? 'promo' : 'signal',  // 'signal'|'promo'|'news'
  headline,             // promo/news: main headline text (single item compat)
  subline,              // promo/news: secondary text (single item compat)
  cta,                  // promo/news: call to action
  items,                // news: [{headline, subline}] — multiple news items
} = input;

// ── News items array (supports single headline/subline or items[]) ────────────
const maxNewsItems = format === 'story' ? 9 : format === 'landscape' ? 6 : 5;
const newsItems = (items?.length
  ? items
  : headline ? [{ headline, subline: subline || '' }] : []
).slice(0, maxNewsItems);

// ── Canvas dimensions ───────────────────────────────────────────────────────
const DIMS = {
  square:    { w: 1080, h: 1080, cols: 3, maxCards: 5 },
  story:     { w: 1080, h: 1920, cols: 2, maxCards: 5 },
  landscape: { w: 1200, h:  675, cols: 3, maxCards: 5 },
};
const dim = DIMS[format] || DIMS.square;

const outPath = outputPath || `/workspace/group/tmp/images/creative-${format}-${Date.now()}.png`;
mkdirSync(path.dirname(outPath), { recursive: true });

// ── Official Flago palette ──────────────────────────────────────────────────
const C = {
  primary:    '#8DB600',
  bg:         '#FFFFFF',
  surfaceAlt: '#F8F9F5',
  border:     '#E0E3D8',
  bullish:    '#8DB600',
  bearish:    '#D32F2F',
  neutral:    '#757575',
  textPrimary:'#111111',
  textSec:    '#444444',
  textMuted:  '#888888',
  chipBull:   '#EEF5C0',
  chipBear:   '#FFEBEB',
  chipNeutral:'#F0F0F0',
};

// ── Market → flag emoji ─────────────────────────────────────────────────────
const FLAGS = {
  ibov: '🇧🇷', sp500: '🇺🇸', tsx: '🇨🇦', ipc: '🇲🇽',
  ftse100: '🇬🇧', dax: '🇩🇪', cac40: '🇫🇷', aex: '🇳🇱',
  smi: '🇨🇭', omx: '🇸🇪', ibex35: '🇪🇸', jse: '🇿🇦',
  nikkei225: '🇯🇵', hsi: '🇭🇰', nsei: '🇮🇳', kospi: '🇰🇷',
  asx200: '🇦🇺', jkse: '🇮🇩', klse: '🇲🇾', set50: '🇹🇭',
};

// ── Flago icon ───────────────────────────────────────────────────────────────
let iconBase64 = '';
try { iconBase64 = readFileSync(path.join(__dirname, 'flago.icon.png')).toString('base64'); } catch {}
const iconSrc = iconBase64 ? `data:image/png;base64,${iconBase64}` : '';

const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function chipStyle(tipo) {
  if (tipo === 'bullish') return `background:${C.chipBull};color:${C.bullish};`;
  if (tipo === 'bearish') return `background:${C.chipBear};color:${C.bearish};`;
  return `background:${C.chipNeutral};color:${C.neutral};`;
}
function signalLabel(tipo) {
  if (tipo === 'bullish') return '▲ BULLISH';
  if (tipo === 'bearish') return '▼ BEARISH';
  return '● NEUTRAL';
}
const CURRENCY = {
  sp500: 'US$', tsx: 'CA$', ipc: 'MX$', ibov: 'R$',
  ftse100: '£', dax: '€', cac40: '€', aex: '€',
  smi: 'CHF ', omx: 'kr ', ibex35: '€', jse: 'R ',
  nikkei225: '¥', hsi: 'HK$', nsei: '₹', kospi: '₩',
  asx200: 'A$', jkse: 'Rp ', klse: 'RM ', set50: '฿',
};
function priceStr(preco, indice) {
  if (!preco || preco === 0) return { sym: '', num: '—' };
  const sym = CURRENCY[indice?.toLowerCase()] || '$';
  const num = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(preco);
  return { sym, num };
}
function tickerColor(tipo) {
  if (tipo === 'bullish') return C.bullish;
  if (tipo === 'bearish') return C.bearish;
  return C.textPrimary;
}

const displayAssets = assets.slice(0, dim.maxCards);

// ── Layout scaling per format ───────────────────────────────────────────────
// landscape needs smaller type since canvas is 675px tall
// story: mesma largura do square (1080px) — não escalar colunas, só os rows ficam maiores
const scale = format === 'landscape' ? 0.65 : 1;
const px = n => `${Math.round(n * scale)}px`;

// ── Capture time ─────────────────────────────────────────────────────────────
const captureDate = capturedAt ? new Date(capturedAt) : new Date();
const captureTimeStr = captureDate.toUTCString().replace(/.*(\d{2}:\d{2}):\d{2} GMT/, '$1 UTC');

const signalRows = displayAssets.map((a, i) => {
  const flag   = FLAGS[a.indice?.toLowerCase()] || '🌐';
  const chip   = chipStyle(a.tipo);
  const label  = signalLabel(a.tipo);
  const price  = priceStr(a.preco, a.indice);
  const tColor = tickerColor(a.tipo);
  const rowBg  = i % 2 === 0 ? C.bg : C.surfaceAlt;
  return `
  <div class="signal-row" style="background:${rowBg}">
    <div class="sr-col sr-col-ticker">
      <span class="sr-flag">${flag}</span>
      <span class="sr-ticker" style="color:${tColor}">${esc(a.ticker)}</span>
    </div>
    ${format !== 'story' ? `<div class="sr-col sr-col-name">
      <span class="sr-name">${esc(a.nome || '')}</span>
    </div>` : ''}
    <div class="sr-col sr-col-indicator">
      <span class="sr-indicator">${esc((a.indicador || '').toUpperCase())}</span>
    </div>
    <div class="sr-col sr-col-chip">
      <span class="sr-chip" style="${chip}">${label}</span>
    </div>
    <div class="sr-col sr-col-price">
      ${price.num === '—'
        ? `<span class="sr-price" style="color:${tColor}">—</span>`
        : `<span class="sr-currency" style="color:${tColor}">${esc(price.sym)}</span><span class="sr-price" style="color:${tColor}">${esc(price.num)}</span>`
      }
    </div>
  </div>`;
}).join('');

// ── Promo / News body content ─────────────────────────────────────────────────

// Weekly promo rotation — cycles through 6 variants, one per ISO week.
// Override by passing headline/subline/cta explicitly in the input.
const PROMO_VARIANTS = [
  {
    headline: '20 global markets.<br><em>One signal.</em>',
    subline:  'Technical signals from 20 indices across 4 continents — automatically selected, delivered to you.',
    cta:      'Start free at flago.io',
  },
  {
    headline: 'Bullish or bearish?<br><em>Always know.</em>',
    subline:  'MACD, RSI, OBV and more — Flago picks the best-performing indicator for each asset, automatically.',
    cta:      'See the signals — flago.io',
  },
  {
    headline: 'Stop watching.<br><em>Start acting.</em>',
    subline:  'Set your watchlist once. Flago monitors 20 global markets and alerts you the moment a signal fires.',
    cta:      '14-day free trial at flago.io',
  },
  {
    headline: 'Your signal.<br><em>Your way.</em>',
    subline:  'WhatsApp, email or push — choose how you receive alerts from 20 indices around the world.',
    cta:      'Start free at flago.io',
  },
  {
    headline: 'From Tokyo to New York.<br><em>One dashboard.</em>',
    subline:  'Technical signals from Asia, Europe, Africa and the Americas — all in one place, all the time.',
    cta:      'Explore markets at flago.io',
  },
  {
    headline: 'Signal strength.<br><em>Across 20 markets.</em>',
    subline:  'Flago reads the technicals so you can act on signals, not noise. Try free for 14 days.',
    cta:      'Start free at flago.io',
  },
];

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

const weekVariant = PROMO_VARIANTS[isoWeek(new Date()) % PROMO_VARIANTS.length];

const promoHeadline = headline || weekVariant.headline;
const promoSubline  = subline  || weekVariant.subline;
const promoCta      = cta      || weekVariant.cta;

// Shared market pill HTML fragments by region
const pillsAsia = `<span class="market-pill">🇯🇵 Nikkei</span><span class="market-pill">🇰🇷 KOSPI</span><span class="market-pill">🇦🇺 ASX 200</span><span class="market-pill">🇭🇰 HSI</span><span class="market-pill">🇮🇩 JKSE</span><span class="market-pill">🇲🇾 KLSE</span><span class="market-pill">🇹🇭 SET 50</span><span class="market-pill">🇮🇳 NSEI</span>`;
const pillsEurope = `<span class="market-pill">🇬🇧 FTSE 100</span><span class="market-pill">🇩🇪 DAX</span><span class="market-pill">🇫🇷 CAC 40</span><span class="market-pill">🇳🇱 AEX</span><span class="market-pill">🇨🇭 SMI</span><span class="market-pill">🇸🇪 OMX</span><span class="market-pill">🇪🇸 IBEX 35</span><span class="market-pill">🇿🇦 JSE</span>`;
const pillsAmericas = `<span class="market-pill">🇺🇸 S&amp;P 500</span><span class="market-pill">🇨🇦 TSX</span><span class="market-pill">🇲🇽 IPC</span><span class="market-pill">🇧🇷 IBOV</span>`;

const promoBodyDefault = `
  <div class="promo-body">
    <div class="promo-top">
      <div class="promo-headline">${promoHeadline}</div>
      <div class="promo-subline">${esc(promoSubline)}</div>
    </div>
    <div class="promo-stats">
      <div class="promo-stat"><span class="promo-stat-num">20</span><span class="promo-stat-label">Global<br>Indices</span></div>
      <div class="promo-stat-sep"></div>
      <div class="promo-stat"><span class="promo-stat-num">10</span><span class="promo-stat-label">Technical<br>Indicators</span></div>
      <div class="promo-stat-sep"></div>
      <div class="promo-stat"><span class="promo-stat-num" style="font-size:${px(42)}">1,800+</span><span class="promo-stat-label">Assets<br>Monitored</span></div>
    </div>
    <div class="promo-markets">
      ${pillsAsia}${pillsEurope}${pillsAmericas}
    </div>
    <div class="promo-cta">${esc(promoCta)}</div>
  </div>`;

const promoBodyStory = `
  <div class="promo-body" style="justify-content:flex-start;gap:${px(56)};padding:${px(72)} ${px(72)} ${px(64)}">
    <div class="promo-top" style="text-align:center;gap:${px(28)}">
      <div class="promo-headline" style="font-size:${px(120)};line-height:1.0">${promoHeadline}</div>
      <div class="promo-subline" style="font-size:${px(26)};line-height:1.6;max-width:${px(840)}">${esc(promoSubline)}</div>
    </div>
    <div class="promo-stats" style="max-width:none;width:100%;padding:${px(44)} 0;border-top:2px solid ${C.border};border-bottom:2px solid ${C.border}">
      <div class="promo-stat"><span class="promo-stat-num" style="font-size:${px(88)}">20</span><span class="promo-stat-label" style="font-size:${px(17)}">Global<br>Indices</span></div>
      <div class="promo-stat-sep"></div>
      <div class="promo-stat"><span class="promo-stat-num" style="font-size:${px(88)}">10</span><span class="promo-stat-label" style="font-size:${px(17)}">Technical<br>Indicators</span></div>
      <div class="promo-stat-sep"></div>
      <div class="promo-stat"><span class="promo-stat-num" style="font-size:${px(64)}">1,800+</span><span class="promo-stat-label" style="font-size:${px(17)}">Assets<br>Monitored</span></div>
    </div>
    <div class="promo-regions" style="gap:${px(40)};max-width:none;width:100%">
      <div class="promo-region">
        <div class="promo-region-label" style="font-size:${px(14)};padding-bottom:${px(12)}">🌏 Asia Pacific</div>
        <div class="promo-markets" style="justify-content:flex-start;gap:${px(10)}">${pillsAsia.replace(/class="market-pill"/g, `class="market-pill" style="font-size:${px(16)};padding:${px(10)} ${px(20)}"`)}
        </div>
      </div>
      <div class="promo-region">
        <div class="promo-region-label" style="font-size:${px(14)};padding-bottom:${px(12)}">🌍 Europe &amp; Africa</div>
        <div class="promo-markets" style="justify-content:flex-start;gap:${px(10)}">${pillsEurope.replace(/class="market-pill"/g, `class="market-pill" style="font-size:${px(16)};padding:${px(10)} ${px(20)}"`)}
        </div>
      </div>
      <div class="promo-region">
        <div class="promo-region-label" style="font-size:${px(14)};padding-bottom:${px(12)}">🌎 Americas</div>
        <div class="promo-markets" style="justify-content:flex-start;gap:${px(10)}">${pillsAmericas.replace(/class="market-pill"/g, `class="market-pill" style="font-size:${px(16)};padding:${px(10)} ${px(20)}"`)}
        </div>
      </div>
    </div>
    <div style="width:100%;background:${C.primary};border-radius:${px(20)};padding:${px(32)} ${px(56)};text-align:center">
      <div style="font-size:${px(30)};font-weight:900;color:#fff;letter-spacing:-0.3px">${esc(promoCta)}</div>
    </div>
  </div>`;

const promoBodyLandscape = `
  <div class="promo-body-land">
    <div class="promo-col-left">
      <div class="promo-headline" style="font-size:${px(40)};text-align:left;letter-spacing:-1px">${promoHeadline}</div>
      <div class="promo-subline" style="text-align:left;max-width:100%;font-size:${px(14)}">${esc(promoSubline)}</div>
      <div style="display:flex;gap:${px(20)};align-items:center;border-top:1px solid ${C.border};padding-top:${px(16)}">
        <div style="display:flex;flex-direction:column;gap:${px(3)}">
          <span style="font-size:${px(28)};font-weight:900;color:${C.primary};line-height:1;letter-spacing:-1px">20</span>
          <span style="font-size:${px(9)};font-weight:700;color:${C.textMuted};letter-spacing:1.5px;text-transform:uppercase">Global Markets</span>
        </div>
        <div style="width:1px;background:${C.border};align-self:stretch"></div>
        <div style="display:flex;flex-direction:column;gap:${px(3)}">
          <span style="font-size:${px(28)};font-weight:900;color:${C.primary};line-height:1;letter-spacing:-1px">10</span>
          <span style="font-size:${px(9)};font-weight:700;color:${C.textMuted};letter-spacing:1.5px;text-transform:uppercase">Indicators</span>
        </div>
        <div style="width:1px;background:${C.border};align-self:stretch"></div>
        <div style="display:flex;flex-direction:column;gap:${px(3)}">
          <span style="font-size:${px(20)};font-weight:900;color:${C.primary};line-height:1;letter-spacing:-1px">1,800+</span>
          <span style="font-size:${px(9)};font-weight:700;color:${C.textMuted};letter-spacing:1.5px;text-transform:uppercase">Assets</span>
        </div>
      </div>
      <div class="promo-cta" style="text-align:left;font-size:${px(13)}">${esc(promoCta)}</div>
    </div>
    <div class="promo-col-right">
      <div style="font-size:${px(9)};font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.textMuted};margin-bottom:${px(10)}">20 markets covered</div>
      <div class="promo-markets" style="justify-content:flex-start;gap:${px(6)}">
        <span class="market-pill">🇺🇸 S&amp;P 500</span><span class="market-pill">🇬🇧 FTSE 100</span>
        <span class="market-pill">🇩🇪 DAX</span><span class="market-pill">🇫🇷 CAC 40</span>
        <span class="market-pill">🇳🇱 AEX</span><span class="market-pill">🇨🇭 SMI</span>
        <span class="market-pill">🇸🇪 OMX</span><span class="market-pill">🇪🇸 IBEX 35</span>
        <span class="market-pill">🇿🇦 JSE</span><span class="market-pill">🇯🇵 Nikkei</span>
        <span class="market-pill">🇰🇷 KOSPI</span><span class="market-pill">🇦🇺 ASX 200</span>
        <span class="market-pill">🇭🇰 HSI</span><span class="market-pill">🇮🇳 NSEI</span>
        <span class="market-pill">🇧🇷 IBOV</span><span class="market-pill">🇨🇦 TSX</span>
        <span class="market-pill">🇲🇽 IPC</span><span class="market-pill">🇮🇩 JKSE</span>
        <span class="market-pill">🇲🇾 KLSE</span><span class="market-pill">🇹🇭 SET 50</span>
      </div>
    </div>
  </div>`;

const promoBody = format === 'landscape' ? promoBodyLandscape : format === 'story' ? promoBodyStory : promoBodyDefault;

const newsItemsHtml = newsItems.map((item, i) => `
  <div class="news-item">
    <div class="news-item-num">${String(i + 1).padStart(2, '0')}</div>
    <div class="news-item-body">
      <div class="news-item-headline">${esc(item.headline || '')}</div>
      ${item.subline ? `<div class="news-item-subline">${esc(item.subline)}</div>` : ''}
    </div>
  </div>`).join('');

const newsBodyDefault = `
  <div class="news-body">
    <div class="news-header">
      <div class="news-tag">Market News</div>
      <div class="news-sep"></div>
    </div>
    <div class="news-items">${newsItemsHtml}</div>
    <div class="news-cta">${esc(promoCta)}</div>
  </div>`;

const newsBodyLandscape = `
  <div class="news-body" style="padding:${px(28)} ${px(52)};gap:${px(20)}">
    <div class="news-header">
      <div class="news-tag">Market News</div>
      <div class="news-sep"></div>
    </div>
    <div class="news-items-2col">${newsItemsHtml}</div>
    <div class="news-cta">${esc(promoCta)}</div>
  </div>`;

const newsBody = format === 'landscape' ? newsBodyLandscape : newsBodyDefault;

const signalBody = `
  <div class="sl-header">
    <span class="sl-count">${displayAssets.length} signals</span>
    <span class="sl-dot">·</span>
    <span class="sl-label">${esc(sessionLabel)}</span>
  </div>
  <div class="signal-list">${signalRows}</div>`;

const mainBody = type === 'promo' ? promoBody : type === 'news' ? newsBody : signalBody;

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    width: ${dim.w}px; height: ${dim.h}px;
    margin: 0; padding: 0; overflow: hidden;
  }

  body {
    background: ${C.bg};
    font-family: 'Nunito', -apple-system, BlinkMacSystemFont, sans-serif;
    display: flex; flex-direction: column;
    position: absolute; inset: 0;
  }

  /* ── Topbar ── */
  .topbar {
    background: #FFFFFF;
    display: flex; align-items: center; justify-content: space-between;
    padding: ${px(26)} ${px(52)} ${px(22)};
    border-bottom: 2px solid ${C.border};
    flex-shrink: 0;
  }
  /* Left: icon + "Flago" — matches Flutter FlagoAppBar (w800, 26px) */
  .brand { display: flex; align-items: center; gap: ${px(10)}; }
  .brand-icon { width: ${px(44)}; height: ${px(44)}; object-fit: contain; }
  .brand-name {
    font-size: ${px(26)}; font-weight: 800;
    color: ${C.textPrimary}; letter-spacing: 0.5px;
  }
  /* Center: slogan — between brand-name and session info */
  .brand-slogan {
    font-size: ${px(11)}; font-weight: 700;
    color: ${C.textMuted}; letter-spacing: 1.8px; text-transform: uppercase;
  }
  /* Right: session badge + capture time stacked */
  .session-info { display: flex; flex-direction: column; align-items: flex-end; gap: ${px(4)}; }
  .session-badge {
    font-size: ${px(13)}; font-weight: 700; letter-spacing: 0.5px;
    color: ${C.textSec}; text-transform: uppercase;
    border: 1.5px solid ${C.border}; border-radius: 20px; padding: ${px(7)} ${px(18)};
  }
  .capture-time {
    font-size: ${px(10)}; font-weight: 600;
    color: ${C.textMuted}; letter-spacing: 0.3px;
  }

  /* ── Signal list layout ── */
  .sl-header {
    padding: ${px(10)} ${px(36)};
    display: flex; align-items: center; gap: ${px(10)};
    border-bottom: 2px solid ${C.border};
    flex-shrink: 0;
  }
  .sl-count {
    font-size: ${px(14)}; font-weight: 800; color: ${C.primary};
    letter-spacing: 1.5px; text-transform: uppercase;
  }
  .sl-dot { color: ${C.border}; font-size: ${px(17)}; }
  .sl-label {
    font-size: ${px(14)}; font-weight: 700; color: ${C.textMuted};
    letter-spacing: 0.8px; text-transform: uppercase;
  }

  .signal-list {
    flex: 1; display: flex; flex-direction: column;
    min-height: 0; overflow: hidden;
  }
  .signal-row {
    flex: 1; min-height: 0; display: flex; align-items: center;
    padding: 0 ${px(60)}; gap: ${px(20)};
    border-bottom: 1px solid ${C.border};
  }
  .signal-row:last-child { border-bottom: none; }

  /* 5-column table layout — aligns all rows like a terminal */
  .sr-col { display: flex; align-items: center; flex-shrink: 0; overflow: hidden; }

  /* Col 1: flag + ticker */
  .sr-col-ticker { gap: ${px(16)}; width: ${px(264)}; }
  .sr-flag   { font-size: ${px(52)}; line-height: 1; flex-shrink: 0; }
  .sr-ticker {
    font-size: ${px(52)}; font-weight: 900; letter-spacing: -0.5px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Col 2: company name — takes remaining space */
  .sr-col-name { flex: 1; min-width: 0; padding-right: ${px(12)}; }
  .sr-name {
    font-size: ${px(22)}; font-weight: 600; color: ${C.textMuted};
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* Col 3: indicator */
  .sr-col-indicator { width: ${px(210)}; justify-content: flex-start; }
  .sr-indicator {
    font-size: ${px(20)}; font-weight: 700; color: ${C.textSec};
    letter-spacing: 0.3px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; max-width: 100%;
  }

  /* Col 4: bullish/bearish chip */
  .sr-col-chip { width: ${px(170)}; justify-content: center; }
  .sr-chip {
    font-size: ${px(18)}; font-weight: 800; letter-spacing: 1px;
    border-radius: 20px; padding: ${px(8)} ${px(18)};
    text-transform: uppercase; white-space: nowrap; display: inline-block;
  }

  /* Col 5: price — right-aligned, currency symbol smaller than number */
  .sr-col-price { width: ${px(210)}; justify-content: flex-end; align-items: baseline; gap: ${px(2)}; }
  .sr-currency {
    font-size: ${px(26)}; font-weight: 800; letter-spacing: -0.3px; line-height: 1;
  }
  .sr-price {
    font-size: ${px(46)}; font-weight: 900; letter-spacing: -0.5px; line-height: 1;
  }

  /* ── Promo layout ── */
  /* Promo — square (default) */
  .promo-body {
    flex: 1; display: flex; flex-direction: column;
    justify-content: space-between; align-items: center;
    padding: ${px(44)} ${px(64)};
    text-align: center;
  }
  .promo-top { display: flex; flex-direction: column; align-items: center; gap: ${px(14)}; }
  .promo-headline {
    font-size: ${px(62)}; font-weight: 900;
    color: ${C.textPrimary}; line-height: 1.05; letter-spacing: -1.5px;
  }
  .promo-headline em { color: ${C.primary}; font-style: normal; }
  .promo-subline {
    font-size: ${px(17)}; font-weight: 600;
    color: ${C.textSec}; line-height: 1.5; max-width: ${px(820)};
  }
  .promo-stats {
    display: flex; align-items: center;
    width: 100%; max-width: ${px(700)};
    border-top: 1px solid ${C.border}; border-bottom: 1px solid ${C.border};
    padding: ${px(22)} 0;
  }
  .promo-stat {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: ${px(6)};
  }
  .promo-stat-num {
    font-size: ${px(44)}; font-weight: 900; color: ${C.primary};
    line-height: 1; letter-spacing: -1.5px;
  }
  .promo-stat-label {
    font-size: ${px(10)}; font-weight: 700; color: ${C.textMuted};
    letter-spacing: 1.5px; text-transform: uppercase; text-align: center;
  }
  .promo-stat-sep { width: 1px; align-self: stretch; background: ${C.border}; }
  .promo-markets {
    display: flex; flex-wrap: wrap; gap: ${px(8)};
    justify-content: center; max-width: ${px(900)};
  }
  .market-pill {
    font-size: ${px(12)}; font-weight: 700;
    background: ${C.surfaceAlt}; border: 1.5px solid ${C.border};
    border-radius: 20px; padding: ${px(6)} ${px(14)};
    color: ${C.textSec};
  }
  .promo-cta {
    font-size: ${px(16)}; font-weight: 800;
    color: ${C.primary}; letter-spacing: 0.3px;
  }
  /* Promo — story: regional breakdown fills the tall canvas */
  .promo-regions {
    display: flex; flex-direction: column; gap: ${px(22)};
    width: 100%; max-width: ${px(900)};
  }
  .promo-region { display: flex; flex-direction: column; gap: ${px(10)}; }
  .promo-region-label {
    font-size: ${px(11)}; font-weight: 800; letter-spacing: 2px;
    text-transform: uppercase; color: ${C.textMuted};
    border-bottom: 1px solid ${C.border}; padding-bottom: ${px(6)};
  }

  /* Promo — landscape: 2 columns */
  .promo-body-land {
    flex: 1; display: flex; flex-direction: row;
    align-items: stretch;
    padding: ${px(28)} ${px(52)};
    gap: ${px(48)};
  }
  .promo-col-left {
    flex: 1; display: flex; flex-direction: column;
    justify-content: space-between; gap: ${px(16)};
    border-right: 1px solid ${C.border};
    padding-right: ${px(48)};
  }
  .promo-col-right {
    width: ${px(340)}; flex-shrink: 0;
    display: flex; flex-direction: column;
    justify-content: space-between; gap: ${px(10)};
  }
  .promo-col-right .market-pill { font-size: ${px(11)}; padding: ${px(6)} ${px(12)}; }
  .promo-col-right .promo-markets { justify-content: flex-start; }

  /* ── News layout — single column (square + story) ── */
  .news-body {
    flex: 1; display: flex; flex-direction: column;
    padding: ${px(44)} ${px(72)};
    gap: ${px(28)};
  }
  .news-header { display: flex; flex-direction: column; gap: ${px(12)}; flex-shrink: 0; }
  .news-tag {
    font-size: ${px(11)}; font-weight: 800; letter-spacing: 2.5px;
    text-transform: uppercase; color: ${C.primary};
  }
  .news-sep { height: 1px; background: ${C.border}; }

  /* Multi-item feed */
  .news-items { display: flex; flex-direction: column; flex: 1; }
  .news-item {
    display: flex; align-items: flex-start; gap: ${px(18)};
    padding: ${px(16)} 0;
    border-bottom: 1px solid ${C.border};
  }
  .news-item:last-child { border-bottom: none; }
  .news-item-num {
    font-size: ${px(11)}; font-weight: 900; color: ${C.primary};
    letter-spacing: 1px; padding-top: ${px(4)}; flex-shrink: 0; width: ${px(28)};
  }
  .news-item-body { flex: 1; display: flex; flex-direction: column; gap: ${px(6)}; }
  .news-item-headline {
    font-size: ${px(34)}; font-weight: 900;
    color: ${C.textPrimary}; line-height: 1.1; letter-spacing: -0.5px;
  }
  .news-item-subline {
    font-size: ${px(15)}; font-weight: 500;
    color: ${C.textSec}; line-height: 1.5;
  }
  /* Story: bigger text to fill tall canvas */
  .fmt-story .news-item { padding: ${px(22)} 0; }
  .fmt-story .news-item-headline { font-size: ${px(40)}; }
  .fmt-story .news-item-subline  { font-size: ${px(18)}; }

  .news-cta {
    font-size: ${px(13)}; font-weight: 800;
    color: ${C.primary}; letter-spacing: 0.3px; padding-top: ${px(8)};
    border-top: 1px solid ${C.border};
  }

  /* Landscape news: 2-column items grid */
  .news-items-2col {
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 0 ${px(40)}; flex: 1;
  }
  .news-items-2col .news-item { border-bottom: 1px solid ${C.border}; }
  .news-items-2col .news-item:nth-last-child(-n+2) { border-bottom: none; }

  /* ── News layout — two columns (landscape only) ── */
  .news-body-land {
    flex: 1; display: flex; flex-direction: row;
    padding: ${px(32)} ${px(52)};
    gap: ${px(40)};
    align-items: stretch;
  }
  .news-col-left {
    flex: 1; display: flex; flex-direction: column;
    justify-content: center; gap: ${px(16)};
    border-right: 1px solid ${C.border};
    padding-right: ${px(40)};
  }
  .news-col-right {
    width: ${px(320)}; flex-shrink: 0;
    display: flex; flex-direction: column;
    justify-content: space-between;
  }
  .news-stats-vert {
    display: flex; flex-direction: column; gap: 0;
    flex: 1;
  }
  .news-stat-v {
    flex: 1; display: flex; flex-direction: column;
    justify-content: center; align-items: flex-start;
    border-bottom: 1px solid ${C.border};
    padding: ${px(10)} 0;
  }
  .news-stat-v:last-child { border-bottom: none; }
  .news-stat-v .news-stat-num { font-size: ${px(38)}; letter-spacing: -1px; }
  .news-stat-v .news-stat-label { margin-top: ${px(4)}; text-align: left; }

  /* ── Footer ── */
  .footer {
    padding: ${px(12)} ${px(52)} ${px(22)};
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0;
  }
  .footer-left { font-size: ${px(11)}; font-weight: 600; color: ${C.textMuted}; }
  .footer-disclaimer { font-size: ${px(10)}; font-weight: 600; color: ${C.textMuted}; letter-spacing: 0.2px; }
  .footer-right { font-size: ${px(13)}; font-weight: 800; color: ${C.primary}; letter-spacing: 0.5px; }

  /* ── Landscape compactness — reduce chrome to give rows more vertical room ── */
  .fmt-landscape .topbar { padding-top: ${px(18)}; padding-bottom: ${px(14)}; }
  .fmt-landscape .sl-header { padding-top: ${px(6)}; padding-bottom: ${px(6)}; }
  .fmt-landscape .footer { padding-top: ${px(8)}; padding-bottom: ${px(12)}; }

  /* ── Story — larger header + footer for 1920px canvas ── */
  .fmt-story .topbar { padding: ${px(40)} ${px(52)} ${px(36)}; }
  .fmt-story .brand-icon { width: ${px(60)}; height: ${px(60)}; }
  .fmt-story .brand-name { font-size: ${px(36)}; }
  .fmt-story .brand-slogan { font-size: ${px(15)}; letter-spacing: 2px; }
  .fmt-story .session-badge { font-size: ${px(18)}; padding: ${px(10)} ${px(22)}; }
  .fmt-story .capture-time { font-size: ${px(13)}; }
  .fmt-story .sl-header { padding: ${px(16)} ${px(36)}; }
  .fmt-story .sl-count { font-size: ${px(18)}; }
  .fmt-story .sl-label { font-size: ${px(18)}; }
  .fmt-story .footer { padding: ${px(24)} ${px(52)} ${px(40)}; }
  .fmt-story .footer-left { font-size: ${px(16)}; }
  .fmt-story .footer-disclaimer { font-size: ${px(15)}; }
  .fmt-story .footer-right { font-size: ${px(22)}; }
</style>
</head>
<body class="fmt-${format}">

  <div class="topbar">
    <div class="brand">
      ${iconSrc ? `<img class="brand-icon" src="${iconSrc}" />` : ''}
      <span class="brand-name">Flago</span>
    </div>
    <span class="brand-slogan">The signal to act</span>
    <div class="session-info">
      <div class="session-badge">${esc(sessionLabel)}</div>
      <div class="capture-time">captured at ${captureTimeStr}</div>
    </div>
  </div>

  ${mainBody}

  <div class="footer">
    <span class="footer-left">${new Date().toUTCString().replace(/:\d\d GMT/, ' UTC')}</span>
    <span class="footer-disclaimer">Informational signals. No financial advice.</span>
    <span class="footer-right">flago.io</span>
  </div>

</body>
</html>`;

const tmpFile = `/tmp/flago-creative-${Date.now()}.html`;
writeFileSync(tmpFile, html);

try {
  try {
    // On macOS the GUI Chrome subtracts ~88px of browser chrome from --window-size.
    // Chromium on Linux (containers) has no such offset. Add a platform buffer and
    // crop the result so the PNG is always exactly dim.w × dim.h.
    const isMac = process.platform === 'darwin';
    const winH  = isMac ? dim.h + 100 : dim.h;
    execSync(
      `"${CHROMIUM}" --headless --disable-gpu --no-sandbox ` +
      `--force-device-scale-factor=1 ` +
      `--window-size=${dim.w},${winH} ` +
      `--screenshot="${outPath}" ` +
      `"file://${tmpFile}" 2>/dev/null`,
      { timeout: 30000 }
    );
    // Crop to exact target dimensions — keep top dim.h rows, discard bottom padding
    if (isMac) {
      execSync(
        `python3 -c "from PIL import Image; img=Image.open('${outPath}'); img.crop((0,0,${dim.w},${dim.h})).save('${outPath}')" 2>/dev/null`,
        { timeout: 10000 }
      );
    }
  } catch (_chromeErr) {
    // Chrome often exits non-zero on macOS/headless despite writing the file successfully.
    // Check whether the output file was actually produced before treating as failure.
    let stat;
    try { stat = statSync(outPath); } catch {}
    if (!stat || stat.size < 1000) throw _chromeErr;
    // File exists and is non-trivially sized — screenshot succeeded.
  }
  try { unlinkSync(tmpFile); } catch {}

  // Auto-send via IPC
  const chatJid = process.env.NANOCLAW_CHAT_JID || '';
  const groupFolder = process.env.NANOCLAW_GROUP_FOLDER || '';
  if (chatJid && groupFolder) {
    // /workspace/ipc/ is already scoped to this group's IPC dir on the host
    const ipcDir = `/workspace/ipc/messages`;
    mkdirSync(ipcDir, { recursive: true });
    const ipcFile = path.join(ipcDir, `img-${Date.now()}.json`);
    writeFileSync(ipcFile, JSON.stringify({
      type: 'image',
      chatJid,
      imagePath: outPath,
      caption: input.caption || '',
      groupFolder,
      timestamp: new Date().toISOString(),
    }));
  }

  console.log(JSON.stringify({ success: true, path: outPath, format, dimensions: `${dim.w}x${dim.h}` }));
} catch (err) {
  try { unlinkSync(tmpFile); } catch {}
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
