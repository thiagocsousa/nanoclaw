#!/usr/bin/env node
// Create Google Ads campaign for YouTube video
// Env: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN
// Input (stdin): { videoId, objective, audience, dailyBudgetUsd, durationDays }

import { readFileSync } from 'fs';

const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID; // format: 123-456-7890 (dashes optional)
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const LOGIN_CUSTOMER_ID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID; // MCC account ID (optional)

if (!DEVELOPER_TOKEN || !CUSTOMER_ID || !REFRESH_TOKEN || !CLIENT_ID || !CLIENT_SECRET) {
  console.log(JSON.stringify({ error: 'Missing GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, or GOOGLE_ADS_REFRESH_TOKEN' }));
  process.exit(1);
}

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
  if (!data.access_token) throw new Error(`Google token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

const OAUTH_TOKEN = await getAccessToken();

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { videoId, objective = 'VIDEO_VIEWS', audience = {}, dailyBudgetUsd = 10, durationDays = 3 } = input;

const customerId = CUSTOMER_ID.replace(/-/g, '');
const BASE = `https://googleads.googleapis.com/v17/customers/${customerId}`;

const headers = {
  Authorization: `Bearer ${OAUTH_TOKEN}`,
  'developer-token': DEVELOPER_TOKEN,
  'Content-Type': 'application/json',
};
if (LOGIN_CUSTOMER_ID) headers['login-customer-id'] = LOGIN_CUSTOMER_ID.replace(/-/g, '');

async function mutate(operations) {
  const res = await fetch(`${BASE}/googleAds:mutate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ mutateOperations: operations }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || JSON.stringify(data));
  return data;
}

try {
  const dailyBudgetMicros = dailyBudgetUsd * 1_000_000;
  const endDate = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10).replace(/-/g, '');
  const startDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  // 1. Create budget
  const budgetResult = await mutate([{
    campaignBudgetOperation: {
      create: {
        name: `AlertaInvest Budget ${Date.now()}`,
        amountMicros: dailyBudgetMicros.toString(),
        deliveryMethod: 'STANDARD',
      },
    },
  }]);
  const budgetResourceName = budgetResult.mutateOperationResponses[0].campaignBudgetResult.resourceName;

  // 2. Create campaign (Video campaign for YouTube)
  const campaignResult = await mutate([{
    campaignOperation: {
      create: {
        name: `AlertaInvest YouTube - ${new Date().toISOString().slice(0, 10)}`,
        advertisingChannelType: 'VIDEO',
        status: 'ENABLED',
        campaignBudget: budgetResourceName,
        startDate,
        endDate,
        videoCampaignSettings: { videoAdInventoryControl: { inStreamAdAllowed: false } },
        biddingStrategyType: 'TARGET_CPV',
        targetCpv: { targetCpvMicros: '100000' }, // $0.10 per view
      },
    },
  }]);
  const campaignResourceName = campaignResult.mutateOperationResponses[0].campaignResult.resourceName;

  // 3. Create ad group
  const adGroupResult = await mutate([{
    adGroupOperation: {
      create: {
        name: `AlertaInvest AdGroup - ${videoId}`,
        campaign: campaignResourceName,
        status: 'ENABLED',
        adGroupType: 'VIDEO_TRUE_VIEW_IN_DISPLAY',
      },
    },
  }]);
  const adGroupResourceName = adGroupResult.mutateOperationResponses[0].adGroupResult.resourceName;

  // 4. Create video ad
  const adResult = await mutate([{
    adGroupAdOperation: {
      create: {
        adGroup: adGroupResourceName,
        status: 'ENABLED',
        ad: {
          name: `AlertaInvest Video Ad - ${videoId}`,
          videoResponsiveAd: {
            videos: [{ asset: `customers/${customerId}/assets/${videoId}` }],
            headlines: [{ text: 'Stay Ahead of Markets' }],
            longHeadlines: [{ text: 'Alerta Invest — Real-time Investment Signals' }],
            descriptions: [{ text: 'Get actionable investment insights before the market moves.' }],
            callToActions: [{ text: 'Learn More' }],
          },
          finalUrls: [process.env.ALERTA_INVEST_URL || 'https://alertainvest.com'],
        },
      },
    },
  }]);

  console.log(JSON.stringify({
    success: true,
    platform: 'google_ads',
    campaignResourceName,
    adGroupResourceName,
    adResourceName: adResult.mutateOperationResponses[0].adGroupAdResult.resourceName,
    dailyBudgetUsd,
    durationDays,
    estimatedTotal: dailyBudgetUsd * durationDays,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'google_ads' }));
  process.exit(1);
}
