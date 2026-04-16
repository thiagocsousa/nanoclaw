#!/usr/bin/env node
// Fetch signals from Alerta Invest (Flago) API
// Env: FLAGO_API_KEY (optional — endpoint is public when not set)

const BASE_URL = process.env.FLAGO_API_URL ||
  'https://southamerica-east1-alerta-invest-brasil.cloudfunctions.net/get_sinais_recentes';

const API_KEY = process.env.FLAGO_API_KEY;

// Optional filters via env
const LIMIT = process.env.FLAGO_LIMIT || '20';
const APENAS_ABERTOS = process.env.FLAGO_APENAS_ABERTOS || '';
const INDICE = process.env.FLAGO_INDICE || '';

try {
  const params = new URLSearchParams({ limit: LIMIT });
  if (APENAS_ABERTOS === 'true') params.set('apenas_abertos', 'true');
  if (INDICE) params.set('indice', INDICE);

  const url = `${BASE_URL}?${params}`;
  const headers = {};
  if (API_KEY) headers['X-API-Key'] = API_KEY;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const data = await res.json();
  // Response: { gerado_em, mercados_abertos, sinais: [{ ticker, nome, indicador, tipo, preco, indice, timestamp }] }

  const signals = (data.sinais || []).map(s => ({
    ticker: s.ticker || '',
    nome: s.nome || '',
    indicador: s.indicador || '',      // e.g. "macd", "rsi"
    tipo: s.tipo || '',                // e.g. "bullish", "bearish"
    preco: s.preco ?? null,
    indice: s.indice || '',            // e.g. "sp500", "ibov"
    timestamp: s.timestamp || data.gerado_em || new Date().toISOString(),
  }));

  console.log(JSON.stringify({
    source: 'flago',
    fetched_at: data.gerado_em || new Date().toISOString(),
    mercados_abertos: data.mercados_abertos || [],
    signals,
  }));
} catch (err) {
  console.log(JSON.stringify({
    source: 'flago',
    fetched_at: new Date().toISOString(),
    mercados_abertos: [],
    signals: [],
    error: err.message,
  }));
}
