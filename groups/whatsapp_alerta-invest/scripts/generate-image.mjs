#!/usr/bin/env node
// Generate creative image using Chromium headless
// Input (stdin): { ticker, signalType, headline, body, cta, accentColor, outputPath }

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const {
  ticker = 'SPY',
  signalType = 'ALERT',
  headline = '',
  body = '',
  cta = 'Learn More',
  accentColor = '#F5A623',
  outputPath,
} = input;

const outPath = outputPath || `/workspace/group/tmp/creative-${Date.now()}.png`;
mkdirSync(path.dirname(outPath), { recursive: true });

// Signal type colors
const signalColors = {
  BUY: '#00C853',
  SELL: '#D50000',
  ALERT: '#F5A623',
  WATCH: '#2979FF',
};
const color = accentColor || signalColors[signalType] || '#F5A623';

// Escape HTML special chars
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px; height: 1080px;
    background: #060B18;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }
  .bg-glow {
    position: absolute;
    width: 600px; height: 600px;
    border-radius: 50%;
    background: radial-gradient(circle, ${color}22 0%, transparent 70%);
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  .card {
    position: relative;
    width: 900px;
    padding: 72px;
    background: linear-gradient(145deg, #0D1527 0%, #0A0E1A 100%);
    border: 1px solid #1E2940;
    border-radius: 24px;
    display: flex; flex-direction: column; gap: 32px;
  }
  .top-row {
    display: flex; align-items: center; justify-content: space-between;
  }
  .ticker {
    font-size: 52px; font-weight: 900;
    color: #FFFFFF; letter-spacing: -1px;
  }
  .signal-badge {
    font-size: 18px; font-weight: 700; letter-spacing: 3px;
    color: ${color};
    border: 2px solid ${color};
    border-radius: 8px;
    padding: 8px 20px;
    text-transform: uppercase;
  }
  .divider {
    height: 1px;
    background: linear-gradient(90deg, ${color}88, transparent);
  }
  .headline {
    font-size: 44px; font-weight: 800; line-height: 1.15;
    color: #FFFFFF; letter-spacing: -0.5px;
  }
  .headline span { color: ${color}; }
  .body-text {
    font-size: 26px; font-weight: 400; line-height: 1.5;
    color: #8899BB;
  }
  .bottom-row {
    display: flex; align-items: center; justify-content: space-between;
    margin-top: 16px;
  }
  .brand {
    font-size: 20px; font-weight: 700; letter-spacing: 2px;
    color: #FFFFFF; opacity: 0.5;
    text-transform: uppercase;
  }
  .cta-btn {
    font-size: 18px; font-weight: 700;
    color: #060B18;
    background: ${color};
    border-radius: 100px;
    padding: 14px 32px;
    letter-spacing: 0.5px;
  }
  .corner-accent {
    position: absolute;
    top: 0; right: 0;
    width: 200px; height: 200px;
    background: linear-gradient(225deg, ${color}15, transparent);
    border-radius: 0 24px 0 0;
    pointer-events: none;
  }
</style>
</head>
<body>
  <div class="bg-glow"></div>
  <div class="card">
    <div class="corner-accent"></div>
    <div class="top-row">
      <div class="ticker">$${esc(ticker)}</div>
      <div class="signal-badge">${esc(signalType)}</div>
    </div>
    <div class="divider"></div>
    <div class="headline">${esc(headline)}</div>
    <div class="body-text">${esc(body)}</div>
    <div class="bottom-row">
      <div class="brand">Alerta Invest</div>
      <div class="cta-btn">${esc(cta)}</div>
    </div>
  </div>
</body>
</html>`;

const tmpFile = `/tmp/creative-${Date.now()}.html`;
writeFileSync(tmpFile, html);

try {
  execSync(
    `chromium --headless --disable-gpu --no-sandbox ` +
    `--window-size=1080,1080 ` +
    `--screenshot="${outPath}" ` +
    `"file://${tmpFile}" 2>/dev/null`,
    { timeout: 30000 }
  );
  unlinkSync(tmpFile);
  console.log(JSON.stringify({ success: true, path: outPath }));
} catch (err) {
  try { unlinkSync(tmpFile); } catch {}
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
