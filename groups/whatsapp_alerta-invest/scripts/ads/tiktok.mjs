#!/usr/bin/env node
// Create TikTok Ads campaign from published post
// Env: TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID
// Input (stdin): { postId, objective, audience, dailyBudgetUsd, durationDays }

import { readFileSync } from 'fs';

const TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const ADVERTISER_ID = process.env.TIKTOK_ADVERTISER_ID;
const BASE = 'https://business-api.tiktok.com/open_api/v1.3';

if (!TOKEN || !ADVERTISER_ID) {
  console.log(JSON.stringify({ error: 'Missing TIKTOK_ACCESS_TOKEN or TIKTOK_ADVERTISER_ID' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { postId, objective = 'TRAFFIC', audience = {}, dailyBudgetUsd = 20, durationDays = 2 } = input;

const OBJECTIVE_MAP = {
  TRAFFIC: 'TRAFFIC',
  ENGAGEMENT: 'VIDEO_VIEWS',
  CONVERSIONS: 'CONVERSIONS',
  AWARENESS: 'REACH',
};

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw new Error(data.message || JSON.stringify(data));
  return data;
}

try {
  const startTime = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const endTime = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const mappedObjective = OBJECTIVE_MAP[objective] || objective;

  // 1. Create campaign
  const campaign = await postJson('/campaign/create/', {
    advertiser_id: ADVERTISER_ID,
    campaign_name: `AlertaInvest - ${new Date().toISOString().slice(0, 10)}`,
    objective_type: mappedObjective,
    budget_mode: 'BUDGET_MODE_DAY',
    budget: dailyBudgetUsd,
  });

  // 2. Create ad group
  const adGroup = await postJson('/adgroup/create/', {
    advertiser_id: ADVERTISER_ID,
    campaign_id: campaign.data.campaign_id,
    adgroup_name: `AlertaInvest AdGroup - ${postId}`,
    placement_type: 'PLACEMENT_TYPE_AUTOMATIC',
    budget_mode: 'BUDGET_MODE_DAY',
    budget: dailyBudgetUsd,
    schedule_type: 'SCHEDULE_START_END',
    schedule_start_time: startTime,
    schedule_end_time: endTime,
    optimization_goal: mappedObjective === 'TRAFFIC' ? 'CLICK' : 'SHOW',
    bid_type: 'BID_TYPE_NO_BID',
    audience_type: 'CUSTOM',
    age_groups: ['AGE_25_34', 'AGE_35_44', 'AGE_45_54'],
    location_ids: audience.geos?.length ? audience.geos : ['2840'], // 2840 = United States
    interest_category_ids: [],
    gender: 'GENDER_UNLIMITED',
    languages: ['en'],
  });

  // 3. Create ad
  const ad = await postJson('/ad/create/', {
    advertiser_id: ADVERTISER_ID,
    adgroup_id: adGroup.data.adgroup_id,
    creatives: [{
      ad_name: `AlertaInvest Ad - ${postId}`,
      ad_format: 'SINGLE_IMAGE',
      image_ids: [postId],
      ad_text: audience.ad_text || 'Stay ahead of the markets. Follow Alerta Invest.',
      call_to_action: 'LEARN_MORE',
      landing_page_url: process.env.ALERTA_INVEST_URL || 'https://alertainvest.com',
    }],
  });

  console.log(JSON.stringify({
    success: true,
    platform: 'tiktok_ads',
    campaignId: campaign.data.campaign_id,
    adGroupId: adGroup.data.adgroup_id,
    adId: ad.data.ad_ids?.[0],
    dailyBudgetUsd,
    durationDays,
    estimatedTotal: dailyBudgetUsd * durationDays,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'tiktok_ads' }));
  process.exit(1);
}
