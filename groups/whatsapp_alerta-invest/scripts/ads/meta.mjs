#!/usr/bin/env node
// Create Meta Ads campaign from published Instagram post
// Env: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID
// Input (stdin): { postId, objective, audience, dailyBudgetUsd, durationDays }

import { readFileSync } from 'fs';

const TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID; // format: act_XXXXXXXXX
const PAGE_ID = process.env.META_PAGE_ID;
const BASE = 'https://graph.facebook.com/v20.0';

if (!TOKEN || !AD_ACCOUNT || !PAGE_ID) {
  console.log(JSON.stringify({ error: 'Missing META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, or META_PAGE_ID' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const {
  postId,
  objective = 'OUTCOME_TRAFFIC',
  audience = {},
  dailyBudgetUsd = 10,
  durationDays = 3,
} = input;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: TOKEN }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || JSON.stringify(data));
  return data;
}

const OBJECTIVE_MAP = {
  TRAFFIC: 'OUTCOME_TRAFFIC',
  ENGAGEMENT: 'OUTCOME_ENGAGEMENT',
  CONVERSIONS: 'OUTCOME_SALES',
  AWARENESS: 'OUTCOME_AWARENESS',
};

try {
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + durationDays * 24 * 60 * 60 * 1000);
  const mappedObjective = OBJECTIVE_MAP[objective] || objective;
  const dailyBudgetCents = Math.round(dailyBudgetUsd * 100);

  // 1. Create campaign
  const campaign = await postJson(`${BASE}/${AD_ACCOUNT}/campaigns`, {
    name: `AlertaInvest - ${new Date().toISOString().slice(0, 10)}`,
    objective: mappedObjective,
    status: 'ACTIVE',
    special_ad_categories: [],
  });

  // 2. Create ad set with targeting
  const targeting = {
    age_min: audience.age_min || 25,
    age_max: audience.age_max || 55,
    geo_locations: {
      countries: audience.geos || ['US', 'GB', 'CA', 'AU'],
    },
    interests: (audience.interests || ['investing', 'stock market', 'financial news']).map(i => ({ name: i })),
    publisher_platforms: ['instagram', 'facebook'],
    instagram_positions: ['stream', 'explore', 'reels'],
  };

  const adSet = await postJson(`${BASE}/${AD_ACCOUNT}/adsets`, {
    name: `AlertaInvest AdSet - ${new Date().toISOString().slice(0, 10)}`,
    campaign_id: campaign.id,
    daily_budget: dailyBudgetCents,
    billing_event: 'IMPRESSIONS',
    optimization_goal: mappedObjective === 'OUTCOME_TRAFFIC' ? 'LINK_CLICKS' : 'REACH',
    targeting,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    status: 'ACTIVE',
  });

  // 3. Create ad creative using the existing post
  const creative = await postJson(`${BASE}/${AD_ACCOUNT}/adcreatives`, {
    name: `AlertaInvest Creative - ${postId}`,
    object_story_id: `${PAGE_ID}_${postId}`,
  });

  // 4. Create ad
  const ad = await postJson(`${BASE}/${AD_ACCOUNT}/ads`, {
    name: `AlertaInvest Ad - ${postId}`,
    adset_id: adSet.id,
    creative: { creative_id: creative.id },
    status: 'ACTIVE',
  });

  console.log(JSON.stringify({
    success: true,
    platform: 'meta_ads',
    campaignId: campaign.id,
    adSetId: adSet.id,
    adId: ad.id,
    dailyBudgetUsd,
    durationDays,
    estimatedTotal: dailyBudgetUsd * durationDays,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'meta_ads' }));
  process.exit(1);
}
