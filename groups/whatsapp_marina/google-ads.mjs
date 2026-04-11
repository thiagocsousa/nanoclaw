#!/usr/bin/env node
// Google Ads — análise de campanhas de cirurgia refrativa e catarata
// Uso: node google-ads.mjs [tipo] [periodo] [filtro]
//   tipo:    campanhas | grupos | keywords | termos | audiencias | resumo (padrão: resumo)
//   periodo: 7 | 30 | 90 | historico (padrão: 30)
//   filtro:  refrativa | catarata | todos (padrão: todos)
//
// Exemplos:
//   node google-ads.mjs resumo 30
//   node google-ads.mjs keywords 7 refrativa
//   node google-ads.mjs termos 30 catarata

import { readFileSync } from 'fs';

const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const DEV_TOKEN     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CUSTOMER_ID   = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');

const TIPO    = process.argv[2] || 'resumo';
const PERIODO = process.argv[3] || '30';
const FILTRO  = (process.argv[4] || 'todos').toLowerCase();

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !DEV_TOKEN || !CUSTOMER_ID) {
  console.error('Erro: credenciais Google Ads não configuradas no .env');
  process.exit(1);
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth falhou: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function gaql(token, query) {
  const res = await fetch(
    `https://googleads.googleapis.com/v17/customers/${CUSTOMER_ID}/googleAds:search`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'developer-token': DEV_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data.results || [];
}

// ─── Período ─────────────────────────────────────────────────────────────────

function dateRange(periodo) {
  if (periodo === 'historico') return 'ALL_TIME';
  const days = parseInt(periodo);
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  return `BETWEEN '${fmt(start)}' AND '${fmt(end)}'`;
}

function duringClause(periodo) {
  if (periodo === 'historico') return 'DURING ALL_TIME';
  return `DURING LAST_${periodo}_DAYS`;
}

// ─── Filtro de campanha ───────────────────────────────────────────────────────

function campaignFilter() {
  if (FILTRO === 'refrativa') return `AND LOWER(campaign.name) LIKE '%refrativ%'`;
  if (FILTRO === 'catarata')  return `AND LOWER(campaign.name) LIKE '%catarat%'`;
  return '';
}

// ─── Formatação ───────────────────────────────────────────────────────────────

const brl = n => `R$ ${parseFloat(n || 0).toFixed(2)}`;
const pct = n => `${parseFloat(n || 0).toFixed(2)}%`;
const num = n => parseInt(n || 0).toLocaleString('pt-BR');
const sep = () => console.log('─'.repeat(55));

// ─── Relatórios ───────────────────────────────────────────────────────────────

async function campanhas(token) {
  const during = duringClause(PERIODO);
  const filter = campaignFilter();

  const rows = await gaql(token, `
    SELECT
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.cost_per_conversion,
      metrics.conversion_rate
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      ${filter}
    ${during}
    ORDER BY metrics.cost_micros DESC
  `);

  console.log(`\n=== CAMPANHAS — últimos ${PERIODO} dias (${FILTRO}) ===\n`);

  let totalGasto = 0, totalConversoes = 0, totalClicks = 0;

  for (const r of rows) {
    const m = r.metrics;
    const gasto = (m.costMicros || 0) / 1_000_000;
    totalGasto += gasto;
    totalConversoes += parseFloat(m.conversions || 0);
    totalClicks += parseInt(m.clicks || 0);

    sep();
    console.log(`Nome:        ${r.campaign.name}`);
    console.log(`Status:      ${r.campaign.status}`);
    console.log(`Tipo:        ${r.campaign.advertisingChannelType}`);
    console.log(`Gasto:       ${brl(gasto)}`);
    console.log(`Impressões:  ${num(m.impressions)}`);
    console.log(`Clicks:      ${num(m.clicks)}`);
    console.log(`CTR:         ${pct(m.ctr * 100)}`);
    console.log(`CPC médio:   ${brl((m.averageCpc || 0) / 1_000_000)}`);
    console.log(`Conversões:  ${parseFloat(m.conversions || 0).toFixed(1)}`);
    if (m.conversions > 0) {
      console.log(`Custo/conv:  ${brl((m.costPerConversion || 0) / 1_000_000)}`);
      console.log(`Taxa conv:   ${pct(m.conversionRate * 100)}`);
    }
  }

  sep();
  console.log(`TOTAL GASTO:       ${brl(totalGasto)}`);
  console.log(`TOTAL CLICKS:      ${num(totalClicks)}`);
  console.log(`TOTAL CONVERSÕES:  ${totalConversoes.toFixed(1)}`);
  if (totalConversoes > 0) console.log(`CPL MÉDIO:         ${brl(totalGasto / totalConversoes)}`);
  console.log(`\n${rows.length} campanha(s) encontrada(s)`);
}

async function grupos(token) {
  const during = duringClause(PERIODO);
  const filter = campaignFilter();

  const rows = await gaql(token, `
    SELECT
      campaign.name,
      ad_group.name,
      ad_group.status,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions
    FROM ad_group
    WHERE ad_group.status != 'REMOVED'
      ${filter}
    ${during}
    ORDER BY metrics.cost_micros DESC
    LIMIT 50
  `);

  console.log(`\n=== GRUPOS DE ANÚNCIOS — últimos ${PERIODO} dias (${FILTRO}) ===\n`);

  for (const r of rows) {
    const m = r.metrics;
    const gasto = (m.costMicros || 0) / 1_000_000;
    if (gasto < 0.01 && !m.impressions) continue;

    sep();
    console.log(`Campanha:    ${r.campaign.name}`);
    console.log(`Grupo:       ${r.adGroup.name}`);
    console.log(`Gasto:       ${brl(gasto)}`);
    console.log(`Clicks:      ${num(m.clicks)}  |  CTR: ${pct(m.ctr * 100)}`);
    console.log(`CPC médio:   ${brl((m.averageCpc || 0) / 1_000_000)}`);
    console.log(`Conversões:  ${parseFloat(m.conversions || 0).toFixed(1)}`);
  }
  console.log(`\n${rows.length} grupo(s) encontrado(s)`);
}

async function keywords(token) {
  const during = duringClause(PERIODO);
  const filter = campaignFilter();

  const rows = await gaql(token, `
    SELECT
      campaign.name,
      ad_group.name,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.search_impression_share
    FROM keyword_view
    WHERE ad_group_criterion.status != 'REMOVED'
      ${filter}
    ${during}
    ORDER BY metrics.cost_micros DESC
    LIMIT 50
  `);

  console.log(`\n=== PALAVRAS-CHAVE — últimos ${PERIODO} dias (${FILTRO}) ===\n`);

  for (const r of rows) {
    const m = r.metrics;
    const gasto = (m.costMicros || 0) / 1_000_000;
    if (!m.impressions) continue;

    const kw = r.adGroupCriterion?.keyword;
    sep();
    console.log(`Palavra:     [${kw?.matchType}] ${kw?.text}`);
    console.log(`Campanha:    ${r.campaign.name}`);
    console.log(`Gasto:       ${brl(gasto)}`);
    console.log(`Impressões:  ${num(m.impressions)}  |  Clicks: ${num(m.clicks)}`);
    console.log(`CTR:         ${pct(m.ctr * 100)}  |  CPC: ${brl((m.averageCpc || 0) / 1_000_000)}`);
    if (m.conversions > 0) console.log(`Conversões:  ${parseFloat(m.conversions).toFixed(1)}`);
    if (m.searchImpressionShare) console.log(`Imp. Share:  ${pct(m.searchImpressionShare * 100)}`);
  }
  console.log(`\n${rows.length} palavra(s)-chave encontrada(s)`);
}

async function termos(token) {
  const during = duringClause(PERIODO);
  const filter = campaignFilter();

  const rows = await gaql(token, `
    SELECT
      campaign.name,
      search_term_view.search_term,
      search_term_view.status,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions
    FROM search_term_view
    WHERE metrics.impressions > 0
      ${filter}
    ${during}
    ORDER BY metrics.conversions DESC, metrics.clicks DESC
    LIMIT 50
  `);

  console.log(`\n=== TERMOS DE PESQUISA — últimos ${PERIODO} dias (${FILTRO}) ===\n`);

  for (const r of rows) {
    const m = r.metrics;
    const gasto = (m.costMicros || 0) / 1_000_000;

    sep();
    console.log(`Termo:       "${r.searchTermView.searchTerm}"`);
    console.log(`Status:      ${r.searchTermView.status}`);
    console.log(`Campanha:    ${r.campaign.name}`);
    console.log(`Impressões:  ${num(m.impressions)}  |  Clicks: ${num(m.clicks)}`);
    console.log(`CTR:         ${pct(m.ctr * 100)}  |  CPC: ${brl((m.averageCpc || 0) / 1_000_000)}`);
    console.log(`Gasto:       ${brl(gasto)}`);
    if (m.conversions > 0) console.log(`Conversões:  ${parseFloat(m.conversions).toFixed(1)}`);
  }
  console.log(`\n${rows.length} termo(s) encontrado(s)`);
}

async function audiencias(token) {
  const during = duringClause(PERIODO);
  const filter = campaignFilter();

  const rows = await gaql(token, `
    SELECT
      campaign.name,
      ad_group.name,
      ad_group_criterion.type,
      ad_group_criterion.age_range.type,
      ad_group_criterion.gender.type,
      ad_group_criterion.location.geo_target_constant,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions
    FROM ad_group_audience_view
    WHERE metrics.impressions > 0
      ${filter}
    ${during}
    ORDER BY metrics.conversions DESC, metrics.clicks DESC
    LIMIT 50
  `);

  console.log(`\n=== AUDIÊNCIAS / SEGMENTAÇÃO — últimos ${PERIODO} dias (${FILTRO}) ===\n`);

  for (const r of rows) {
    const m = r.metrics;
    const crit = r.adGroupCriterion;
    const gasto = (m.costMicros || 0) / 1_000_000;

    sep();
    console.log(`Tipo:        ${crit?.type}`);
    if (crit?.ageRange?.type) console.log(`Faixa etária: ${crit.ageRange.type}`);
    if (crit?.gender?.type)   console.log(`Gênero:      ${crit.gender.type}`);
    console.log(`Campanha:    ${r.campaign.name} / ${r.adGroup.name}`);
    console.log(`Impressões:  ${num(m.impressions)}  |  Clicks: ${num(m.clicks)}`);
    console.log(`Gasto:       ${brl(gasto)}`);
    if (m.conversions > 0) console.log(`Conversões:  ${parseFloat(m.conversions).toFixed(1)}`);
  }
}

async function resumo(token) {
  console.log(`\n=== RESUMO GOOGLE ADS — últimos ${PERIODO} dias ===\n`);

  // Campanhas resumidas
  const rows = await gaql(token, `
    SELECT
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      AND metrics.impressions > 0
    ${duringClause(PERIODO)}
    ORDER BY metrics.cost_micros DESC
  `);

  let totalGasto = 0, totalConv = 0, totalClicks = 0, totalImpr = 0;

  const refrativa = rows.filter(r => r.campaign.name.toLowerCase().includes('refrativ'));
  const catarata  = rows.filter(r => r.campaign.name.toLowerCase().includes('catarat'));
  const outros    = rows.filter(r =>
    !r.campaign.name.toLowerCase().includes('refrativ') &&
    !r.campaign.name.toLowerCase().includes('catarat')
  );

  const printGroup = (label, items) => {
    if (!items.length) return;
    let g = 0, c = 0;
    console.log(`\n── ${label} ──`);
    for (const r of items) {
      const gasto = (r.metrics.costMicros || 0) / 1_000_000;
      g += gasto; c += parseFloat(r.metrics.conversions || 0);
      console.log(`  ${r.campaign.name}`);
      console.log(`  Gasto: ${brl(gasto)} | Clicks: ${num(r.metrics.clicks)} | CTR: ${pct(r.metrics.ctr * 100)} | Conv: ${parseFloat(r.metrics.conversions || 0).toFixed(1)}`);
    }
    console.log(`  Subtotal: ${brl(g)} | ${c.toFixed(1)} conversões${c > 0 ? ` | CPL: ${brl(g/c)}` : ''}`);
    totalGasto += g; totalConv += c;
    totalClicks += items.reduce((s, r) => s + parseInt(r.metrics.clicks || 0), 0);
    totalImpr   += items.reduce((s, r) => s + parseInt(r.metrics.impressions || 0), 0);
  };

  printGroup('CIRURGIA REFRATIVA', refrativa);
  printGroup('CATARATA', catarata);
  if (outros.length) printGroup('OUTROS', outros);

  sep();
  console.log(`TOTAL GASTO:       ${brl(totalGasto)}`);
  console.log(`TOTAL IMPRESSÕES:  ${num(totalImpr)}`);
  console.log(`TOTAL CLICKS:      ${num(totalClicks)}`);
  console.log(`TOTAL CONVERSÕES:  ${totalConv.toFixed(1)}`);
  if (totalConv > 0) console.log(`CPL MÉDIO:         ${brl(totalGasto / totalConv)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  const token = await getAccessToken();

  switch (TIPO) {
    case 'campanhas':  await campanhas(token);  break;
    case 'grupos':     await grupos(token);     break;
    case 'keywords':   await keywords(token);   break;
    case 'termos':     await termos(token);     break;
    case 'audiencias': await audiencias(token); break;
    case 'resumo':
    default:           await resumo(token);     break;
  }
} catch (err) {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
}
