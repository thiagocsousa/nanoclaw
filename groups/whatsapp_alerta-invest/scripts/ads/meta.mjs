#!/usr/bin/env node
// Boost a published Instagram post via Meta Ads API
// Env: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, INSTAGRAM_BUSINESS_ACCOUNT_ID, FACEBOOK_PAGE_ID
// Input (stdin): { igMediaId, geos?, dailyBudgetUsd?, durationDays? }

import { readFileSync } from 'fs';

const TOKEN      = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT = process.env.META_AD_ACCOUNT_ID;      // act_XXXXXXXXX
const IG_ID      = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const PAGE_ID    = process.env.FACEBOOK_PAGE_ID;
const BASE       = 'https://graph.facebook.com/v20.0';

if (!TOKEN || !AD_ACCOUNT || !IG_ID) {
  console.log(JSON.stringify({ error: 'Missing META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, or INSTAGRAM_BUSINESS_ACCOUNT_ID' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const {
  igMediaId,
  geos = ['US', 'GB', 'CA', 'AU', 'BR'],
  dailyBudgetUsd = 5,
  durationDays = 1,
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

if (!igMediaId) {
  console.log(JSON.stringify({ error: 'Missing igMediaId' }));
  process.exit(1);
}

try {
  const startTime = new Date();
  const endTime   = new Date(startTime.getTime() + durationDays * 24 * 60 * 60 * 1000);
  const dailyBudgetCents = Math.round(dailyBudgetUsd * 100);
  const dateTag = startTime.toISOString().slice(0, 10);

  // 1. Campaign — OUTCOME_ENGAGEMENT for boosted posts
  const campaign = await postJson(`${BASE}/${AD_ACCOUNT}/campaigns`, {
    name: `Flago Boost - ${dateTag}`,
    objective: 'OUTCOME_ENGAGEMENT',
    status: 'ACTIVE',
    special_ad_categories: [],
  });

  // 2. Ad set — investors/traders audience, zone-specific countries
  const adSet = await postJson(`${BASE}/${AD_ACCOUNT}/adsets`, {
    name: `Flago AdSet - ${dateTag}`,
    campaign_id: campaign.id,
    daily_budget: dailyBudgetCents,
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'POST_ENGAGEMENT',
    targeting: {
      age_min: 25,
      age_max: 55,
      geo_locations: { countries: geos },
      interests: [
        { name: 'Investing' },
        { name: 'Stock market' },
        { name: 'Financial news' },
        { name: 'Technical analysis' },
      ],
      publisher_platforms: ['instagram'],
      instagram_positions: ['stream', 'explore'],
    },
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    status: 'ACTIVE',
  });

  // 3. Creative — boost the existing Instagram post directly
  const creative = await postJson(`${BASE}/${AD_ACCOUNT}/adcreatives`, {
    name: `Flago Creative - ${igMediaId}`,
    source_instagram_media_id: igMediaId,
    instagram_actor_id: IG_ID,
  });

  // 4. Ad
  const ad = await postJson(`${BASE}/${AD_ACCOUNT}/ads`, {
    name: `Flago Ad - ${igMediaId}`,
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
