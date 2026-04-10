#!/usr/bin/env node
// Create Reddit Ads campaign from published post
// Env: REDDIT_ADS_CLIENT_ID, REDDIT_ADS_CLIENT_SECRET, REDDIT_ADS_ACCOUNT_ID
// Input (stdin): { postId, subreddit, audience, dailyBudgetUsd, durationDays }

import { readFileSync } from 'fs';

const CLIENT_ID = process.env.REDDIT_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_ADS_CLIENT_SECRET;
const ACCOUNT_ID = process.env.REDDIT_ADS_ACCOUNT_ID;
const BASE = 'https://ads-api.reddit.com/api/v2.0';

if (!CLIENT_ID || !CLIENT_SECRET || !ACCOUNT_ID) {
  console.log(JSON.stringify({ error: 'Missing Reddit Ads credentials (REDDIT_ADS_CLIENT_ID, REDDIT_ADS_CLIENT_SECRET, REDDIT_ADS_ACCOUNT_ID)' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { postId, subreddit, audience = {}, dailyBudgetUsd = 5, durationDays = 3 } = input;

async function getToken() {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AlertaInvest/1.0',
    },
    body: 'grant_type=client_credentials&scope=ads:read ads:edit',
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function postJson(token, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'AlertaInvest/1.0' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

try {
  const token = await getToken();
  const startTime = new Date().toISOString();
  const endTime = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
  const dailyBudgetCents = Math.round(dailyBudgetUsd * 100);

  // 1. Create campaign
  const campaign = await postJson(token, `/accounts/${ACCOUNT_ID}/campaigns`, {
    name: `AlertaInvest - ${new Date().toISOString().slice(0, 10)}`,
    account_id: ACCOUNT_ID,
    objective: 'BRAND_AWARENESS',
    status: 'ACTIVE',
  });

  // 2. Create ad group
  const adGroup = await postJson(token, `/accounts/${ACCOUNT_ID}/ad_groups`, {
    name: `AlertaInvest AdGroup - ${postId}`,
    account_id: ACCOUNT_ID,
    campaign_id: campaign.id,
    bid_strategy: 'AUTOMATED',
    daily_budget: dailyBudgetCents,
    start_time: startTime,
    end_time: endTime,
    targeting: {
      interest_targeting: { interests: (audience.interests || ['investing', 'finance']).map(i => ({ id: i })) },
      subreddit_targeting: {
        subreddits: (audience.subreddits || [subreddit, 'investing', 'stocks', 'personalfinance']).filter(Boolean),
      },
      geos: (audience.geos || ['US', 'GB', 'CA']).map(c => ({ country_code: c })),
    },
  });

  // 3. Create ad (promote existing post)
  const ad = await postJson(token, `/accounts/${ACCOUNT_ID}/ads`, {
    name: `AlertaInvest Ad - ${postId}`,
    account_id: ACCOUNT_ID,
    ad_group_id: adGroup.id,
    post_id: postId,
    status: 'ACTIVE',
  });

  console.log(JSON.stringify({
    success: true,
    platform: 'reddit_ads',
    campaignId: campaign.id,
    adGroupId: adGroup.id,
    adId: ad.id,
    dailyBudgetUsd,
    durationDays,
    estimatedTotal: dailyBudgetUsd * durationDays,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'reddit_ads' }));
  process.exit(1);
}
