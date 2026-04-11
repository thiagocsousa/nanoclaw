#!/usr/bin/env node
// Google Ads — aplica otimizações via API
// Input (stdin): JSON com lista de ações a executar
//
// Tipos de ação suportados:
//   pause_keyword     — pausa palavra-chave pelo texto
//   enable_keyword    — reativa palavra-chave
//   add_negative      — adiciona palavra negativa (campanha ou grupo)
//   adjust_bid        — ajusta lance de palavra-chave
//   add_keyword       — adiciona nova palavra-chave a um grupo
//   pause_ad_group    — pausa grupo de anúncios
//   adjust_budget     — ajusta orçamento diário de campanha
//
// Exemplo de input:
// {
//   "actions": [
//     { "type": "add_negative", "scope": "campaign", "campaignName": "Refrativa - Search", "keyword": "grátis", "matchType": "BROAD" },
//     { "type": "pause_keyword", "campaignName": "Refrativa - Search", "keywordText": "óculos barato" },
//     { "type": "adjust_bid", "campaignName": "Catarata", "adGroupName": "Catarata - Geral", "keywordText": "cirurgia catarata", "bidReais": 4.50 },
//     { "type": "add_keyword", "campaignName": "Refrativa - Search", "adGroupName": "LASIK", "keywordText": "lasik olhos preço", "matchType": "PHRASE", "bidReais": 3.00 },
//     { "type": "adjust_budget", "campaignName": "Catarata", "dailyBudgetReais": 35 }
//   ]
// }

import { readFileSync } from 'fs';

const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const DEV_TOKEN     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CUSTOMER_ID   = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !DEV_TOKEN || !CUSTOMER_ID) {
  console.error('Erro: credenciais Google Ads não configuradas no .env');
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { actions = [] } = input;

if (!actions.length) {
  console.log('Nenhuma ação para aplicar.');
  process.exit(0);
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

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'developer-token': DEV_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function gaql(token, query) {
  const res = await fetch(
    `https://googleads.googleapis.com/v17/customers/${CUSTOMER_ID}/googleAds:search`,
    { method: 'POST', headers: headers(token), body: JSON.stringify({ query }) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data.results || [];
}

async function mutate(token, operations) {
  const res = await fetch(
    `https://googleads.googleapis.com/v17/customers/${CUSTOMER_ID}/googleAds:mutate`,
    { method: 'POST', headers: headers(token), body: JSON.stringify({ mutateOperations: operations }) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data;
}

// ─── Lookups por nome ─────────────────────────────────────────────────────────

const campaignCache = {};
const adGroupCache  = {};
const keywordCache  = {};
const budgetCache   = {};

async function getCampaignId(token, name) {
  if (campaignCache[name]) return campaignCache[name];
  const rows = await gaql(token, `
    SELECT campaign.id, campaign.name, campaign.campaign_budget
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      AND LOWER(campaign.name) LIKE '%${name.toLowerCase()}%'
    LIMIT 5
  `);
  if (!rows.length) throw new Error(`Campanha não encontrada: "${name}"`);
  const r = rows[0];
  campaignCache[name] = { id: r.campaign.id, resourceName: `customers/${CUSTOMER_ID}/campaigns/${r.campaign.id}`, budgetResourceName: r.campaign.campaignBudget };
  return campaignCache[name];
}

async function getAdGroupId(token, campaignName, adGroupName) {
  const key = `${campaignName}|${adGroupName}`;
  if (adGroupCache[key]) return adGroupCache[key];
  const camp = await getCampaignId(token, campaignName);
  const rows = await gaql(token, `
    SELECT ad_group.id, ad_group.name
    FROM ad_group
    WHERE ad_group.status != 'REMOVED'
      AND campaign.id = ${camp.id}
      AND LOWER(ad_group.name) LIKE '%${adGroupName.toLowerCase()}%'
    LIMIT 5
  `);
  if (!rows.length) throw new Error(`Grupo não encontrado: "${adGroupName}" na campanha "${campaignName}"`);
  const r = rows[0];
  adGroupCache[key] = { id: r.adGroup.id, resourceName: `customers/${CUSTOMER_ID}/adGroups/${r.adGroup.id}` };
  return adGroupCache[key];
}

async function getKeywordCriterionId(token, campaignName, adGroupName, keywordText) {
  const key = `${campaignName}|${adGroupName}|${keywordText}`;
  if (keywordCache[key]) return keywordCache[key];
  const camp = await getCampaignId(token, campaignName);
  const rows = await gaql(token, `
    SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group.name
    FROM ad_group_criterion
    WHERE ad_group_criterion.type = 'KEYWORD'
      AND ad_group_criterion.status != 'REMOVED'
      AND campaign.id = ${camp.id}
      AND LOWER(ad_group_criterion.keyword.text) LIKE '%${keywordText.toLowerCase()}%'
    LIMIT 10
  `);
  if (!rows.length) throw new Error(`Keyword não encontrada: "${keywordText}" na campanha "${campaignName}"`);
  const r = rows[0];
  const adGroupId = r.adGroup ? (await gaql(token, `
    SELECT ad_group.id FROM ad_group
    WHERE ad_group.name = '${r.adGroup.name}' AND campaign.id = ${camp.id}
    LIMIT 1
  `))[0]?.adGroup?.id : null;
  const resourceName = `customers/${CUSTOMER_ID}/adGroupCriteria/${adGroupId}~${r.adGroupCriterion.criterionId}`;
  keywordCache[key] = { criterionId: r.adGroupCriterion.criterionId, adGroupId, resourceName };
  return keywordCache[key];
}

// ─── Ações ────────────────────────────────────────────────────────────────────

const MATCH_TYPE_MAP = { BROAD: 'BROAD', PHRASE: 'PHRASE', EXACT: 'EXACT' };

async function pauseKeyword(token, action) {
  const kw = await getKeywordCriterionId(token, action.campaignName, action.adGroupName || '', action.keywordText);
  await mutate(token, [{
    adGroupCriterionOperation: {
      updateMask: 'status',
      update: { resourceName: kw.resourceName, status: 'PAUSED' },
    },
  }]);
  return `✓ Pausada: "${action.keywordText}"`;
}

async function enableKeyword(token, action) {
  const kw = await getKeywordCriterionId(token, action.campaignName, action.adGroupName || '', action.keywordText);
  await mutate(token, [{
    adGroupCriterionOperation: {
      updateMask: 'status',
      update: { resourceName: kw.resourceName, status: 'ENABLED' },
    },
  }]);
  return `✓ Reativada: "${action.keywordText}"`;
}

async function addNegative(token, action) {
  const matchType = MATCH_TYPE_MAP[action.matchType?.toUpperCase()] || 'BROAD';

  if (action.scope === 'campaign' || !action.adGroupName) {
    // Negativa de campanha
    const camp = await getCampaignId(token, action.campaignName);
    await mutate(token, [{
      campaignCriterionOperation: {
        create: {
          campaign: camp.resourceName,
          negative: true,
          keyword: { text: action.keyword, matchType },
        },
      },
    }]);
    return `✓ Negativa de campanha adicionada: [${matchType}] "${action.keyword}" → ${action.campaignName}`;
  } else {
    // Negativa de grupo
    const group = await getAdGroupId(token, action.campaignName, action.adGroupName);
    await mutate(token, [{
      adGroupCriterionOperation: {
        create: {
          adGroup: group.resourceName,
          negative: true,
          keyword: { text: action.keyword, matchType },
        },
      },
    }]);
    return `✓ Negativa de grupo adicionada: [${matchType}] "${action.keyword}" → ${action.adGroupName}`;
  }
}

async function adjustBid(token, action) {
  const kw = await getKeywordCriterionId(token, action.campaignName, action.adGroupName || '', action.keywordText);
  const bidMicros = Math.round((action.bidReais || action.bidMicros / 1_000_000) * 1_000_000);
  await mutate(token, [{
    adGroupCriterionOperation: {
      updateMask: 'cpc_bid_micros',
      update: { resourceName: kw.resourceName, cpcBidMicros: bidMicros.toString() },
    },
  }]);
  return `✓ Lance ajustado: "${action.keywordText}" → R$ ${(bidMicros / 1_000_000).toFixed(2)}`;
}

async function addKeyword(token, action) {
  const group = await getAdGroupId(token, action.campaignName, action.adGroupName);
  const matchType = MATCH_TYPE_MAP[action.matchType?.toUpperCase()] || 'BROAD';
  const bidMicros = action.bidReais ? Math.round(action.bidReais * 1_000_000) : undefined;

  const create = {
    adGroup: group.resourceName,
    status: 'ENABLED',
    keyword: { text: action.keywordText, matchType },
  };
  if (bidMicros) create.cpcBidMicros = bidMicros.toString();

  await mutate(token, [{ adGroupCriterionOperation: { create } }]);
  return `✓ Keyword adicionada: [${matchType}] "${action.keywordText}" → ${action.adGroupName}${bidMicros ? ` (R$ ${action.bidReais})` : ''}`;
}

async function pauseAdGroup(token, action) {
  const group = await getAdGroupId(token, action.campaignName, action.adGroupName);
  await mutate(token, [{
    adGroupOperation: {
      updateMask: 'status',
      update: { resourceName: group.resourceName, status: 'PAUSED' },
    },
  }]);
  return `✓ Grupo pausado: "${action.adGroupName}"`;
}

async function adjustBudget(token, action) {
  const camp = await getCampaignId(token, action.campaignName);
  const budgetMicros = Math.round(action.dailyBudgetReais * 1_000_000);
  await mutate(token, [{
    campaignBudgetOperation: {
      updateMask: 'amount_micros',
      update: { resourceName: camp.budgetResourceName, amountMicros: budgetMicros.toString() },
    },
  }]);
  return `✓ Orçamento ajustado: "${action.campaignName}" → R$ ${action.dailyBudgetReais}/dia`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const token = await getAccessToken();
const results = [];
const errors  = [];

for (const [i, action] of actions.entries()) {
  const label = `[${i + 1}/${actions.length}] ${action.type}`;
  try {
    let result;
    switch (action.type) {
      case 'pause_keyword':  result = await pauseKeyword(token, action); break;
      case 'enable_keyword': result = await enableKeyword(token, action); break;
      case 'add_negative':   result = await addNegative(token, action);  break;
      case 'adjust_bid':     result = await adjustBid(token, action);    break;
      case 'add_keyword':    result = await addKeyword(token, action);   break;
      case 'pause_ad_group': result = await pauseAdGroup(token, action); break;
      case 'adjust_budget':  result = await adjustBudget(token, action); break;
      default: result = `⚠ Tipo desconhecido: ${action.type}`;
    }
    results.push(result);
    console.log(`${label}: ${result}`);
  } catch (err) {
    const msg = `✗ Erro em ${action.type} ("${action.keyword || action.keywordText || action.campaignName}"): ${err.message}`;
    errors.push(msg);
    console.error(`${label}: ${msg}`);
  }
}

console.log(`\n─────────────────────────────`);
console.log(`Concluído: ${results.length} ok, ${errors.length} erro(s)`);
if (errors.length) process.exit(1);
