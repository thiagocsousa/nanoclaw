#!/usr/bin/env node
// Fetch signals from Alerta Invest (Flago) API
// Env: FLAGO_API_URL, FLAGO_API_KEY

const API_URL = process.env.FLAGO_API_URL;
const API_KEY = process.env.FLAGO_API_KEY;

if (!API_URL) {
  // Return empty signals — pipeline continues without Flago data
  console.log(JSON.stringify({
    source: 'flago',
    fetched_at: new Date().toISOString(),
    signals: [],
    warning: 'FLAGO_API_URL not set — running without signals',
  }));
  process.exit(0);
}

try {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  // Fetch latest signals (expects array of signal objects)
  const res = await fetch(`${API_URL}/signals?limit=20&since=${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}`, { headers });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();

  // Normalize to standard format
  // Expected input: [{ ticker, type, strength, description, timestamp, ... }]
  const signals = (Array.isArray(data) ? data : data.signals || data.data || []).map(s => ({
    ticker: s.ticker || s.symbol || '',
    type: s.type || s.signal_type || s.action || 'ALERT',   // BUY, SELL, ALERT, WATCH
    strength: parseFloat(s.strength || s.score || s.confidence || 5),
    description: s.description || s.message || s.text || '',
    timestamp: s.timestamp || s.created_at || new Date().toISOString(),
    asset_class: s.asset_class || s.category || 'UNKNOWN',  // STOCKS, FOREX, CRYPTO, COMMODITIES
    market: s.market || s.exchange || '',
  }));

  // Sort by strength descending
  signals.sort((a, b) => b.strength - a.strength);

  console.log(JSON.stringify({
    source: 'flago',
    fetched_at: new Date().toISOString(),
    signals,
  }));
} catch (err) {
  console.log(JSON.stringify({
    source: 'flago',
    fetched_at: new Date().toISOString(),
    signals: [],
    error: err.message,
  }));
}
