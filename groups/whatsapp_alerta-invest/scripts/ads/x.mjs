#!/usr/bin/env node
// Create X/Twitter Ads campaign from published tweet
// Env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET, X_AD_ACCOUNT_ID
// Input (stdin): { tweetId, objective, audience, dailyBudgetUsd, durationDays }

import { createHmac } from 'crypto';
import { readFileSync } from 'fs';

const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const ACCESS_SECRET = process.env.X_ACCESS_SECRET;
const AD_ACCOUNT_ID = process.env.X_AD_ACCOUNT_ID;
const BASE = 'https://ads-api.twitter.com/12';

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_SECRET || !AD_ACCOUNT_ID) {
  console.log(JSON.stringify({ error: 'Missing X Ads credentials' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { tweetId, objective = 'WEBSITE_CLICKS', audience = {}, dailyBudgetUsd = 5, durationDays = 3 } = input;

function oauthSign(method, url, params = {}) {
  const nonce = Math.random().toString(36).substring(2) + Date.now().toString(36);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const oauthParams = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: ACCESS_TOKEN,
    oauth_version: '1.0',
    ...params,
  };
  const sortedParams = Object.keys(oauthParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`).join('&');
  const baseString = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(sortedParams)].join('&');
  const signingKey = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(ACCESS_SECRET)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
  oauthParams.oauth_signature = signature;
  return 'OAuth ' + Object.keys(oauthParams).filter(k => k.startsWith('oauth_'))
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');
}

async function apiRequest(method, path, body = null) {
  const url = `${BASE}${path}`;
  const auth = oauthSign(method, url);
  const opts = {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.errors?.[0]?.message || JSON.stringify(data));
  return data;
}

try {
  const endTime = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
  const dailyBudgetMicro = dailyBudgetUsd * 1_000_000; // X uses micro-units (1/1,000,000)

  // 1. Create campaign
  const campaign = await apiRequest('POST', `/accounts/${AD_ACCOUNT_ID}/campaigns`, {
    name: `AlertaInvest - ${new Date().toISOString().slice(0, 10)}`,
    funding_instrument_id: process.env.X_FUNDING_INSTRUMENT_ID, // required
    daily_budget_amount_local_micro: dailyBudgetMicro,
    start_time: new Date().toISOString(),
    end_time: endTime,
    entity_status: 'ACTIVE',
    objective,
  });

  // 2. Create line item (ad group)
  const lineItem = await apiRequest('POST', `/accounts/${AD_ACCOUNT_ID}/line_items`, {
    campaign_id: campaign.data.id,
    name: `AlertaInvest LineItem - ${tweetId}`,
    product_type: 'PROMOTED_TWEETS',
    placements: ['ALL_ON_TWITTER'],
    objective,
    bid_type: 'AUTO',
    entity_status: 'ACTIVE',
  });

  // 3. Create targeting criteria
  await apiRequest('POST', `/accounts/${AD_ACCOUNT_ID}/targeting_criteria`, {
    line_item_id: lineItem.data.id,
    targeting_type: 'LOCATION',
    targeting_value: '96683ccfa95141b5', // Worldwide
  });

  // 4. Create promoted tweet
  await apiRequest('POST', `/accounts/${AD_ACCOUNT_ID}/promoted_tweets`, {
    line_item_id: lineItem.data.id,
    tweet_ids: [tweetId],
  });

  console.log(JSON.stringify({
    success: true,
    platform: 'x_ads',
    campaignId: campaign.data.id,
    lineItemId: lineItem.data.id,
    dailyBudgetUsd,
    durationDays,
    estimatedTotal: dailyBudgetUsd * durationDays,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'x_ads' }));
  process.exit(1);
}
