#!/usr/bin/env node
// Meta/Instagram analytics — last 7 days
// Env: INSTAGRAM_BUSINESS_ACCOUNT_ID, META_ACCESS_TOKEN

const IG_USER_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;
const BASE = 'https://graph.facebook.com/v20.0';

if (!IG_USER_ID || !TOKEN) {
  console.log(JSON.stringify({ platform: 'instagram', error: 'Missing INSTAGRAM_BUSINESS_ACCOUNT_ID or META_ACCESS_TOKEN', posts: [], summary: {} }));
  process.exit(0);
}

const since = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

try {
  // Get recent media
  const mediaData = await fetchJson(
    `${BASE}/${IG_USER_ID}/media?fields=id,caption,timestamp,media_type,permalink&since=${since}&limit=20&access_token=${TOKEN}`
  );

  const posts = [];
  for (const post of (mediaData.data || [])) {
    // Get insights per post
    let impressions = 0, reach = 0, engagement = 0, saved = 0;
    try {
      const insightData = await fetchJson(
        `${BASE}/${post.id}/insights?metric=impressions,reach,engagement,saved&access_token=${TOKEN}`
      );
      for (const m of (insightData.data || [])) {
        if (m.name === 'impressions') impressions = m.values?.[0]?.value || 0;
        if (m.name === 'reach') reach = m.values?.[0]?.value || 0;
        if (m.name === 'engagement') engagement = m.values?.[0]?.value || 0;
        if (m.name === 'saved') saved = m.values?.[0]?.value || 0;
      }
    } catch { /* insights may not be available for all post types */ }

    // Check if post was boosted (check ad creatives linked to this post)
    let paid = { spend: 0, cpc: 0, ctr: 0, clicks: 0 };
    try {
      const adData = await fetchJson(
        `${BASE}/${IG_USER_ID}/insights?metric=impressions&breakdown=media_product_type&since=${since}&period=day&access_token=${TOKEN}`
      );
      // paid data would come from Ads API — simplified here
    } catch { /* optional */ }

    posts.push({
      id: post.id,
      timestamp: post.timestamp,
      type: post.media_type,
      url: post.permalink,
      caption_preview: (post.caption || '').slice(0, 100),
      metrics: { impressions, reach, engagement, saved },
      paid,
    });
  }

  const totalImpressions = posts.reduce((s, p) => s + p.metrics.impressions, 0);
  const totalEngagement = posts.reduce((s, p) => s + p.metrics.engagement, 0);
  const avgEngRate = totalImpressions > 0 ? (totalEngagement / totalImpressions * 100).toFixed(2) : 0;
  const best = posts.sort((a, b) => b.metrics.engagement - a.metrics.engagement)[0];

  console.log(JSON.stringify({
    platform: 'instagram',
    period: '7d',
    posts,
    summary: {
      total_posts: posts.length,
      total_impressions: totalImpressions,
      total_engagement: totalEngagement,
      avg_engagement_rate_pct: parseFloat(avgEngRate),
      best_post_id: best?.id || null,
      best_post_url: best?.url || null,
    },
  }));
} catch (err) {
  console.log(JSON.stringify({ platform: 'instagram', error: err.message, posts: [], summary: {} }));
}
