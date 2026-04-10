#!/usr/bin/env node
// X/Twitter analytics — last 7 days
// Env: X_BEARER_TOKEN, X_USER_ID

const BEARER = process.env.X_BEARER_TOKEN;
const USER_ID = process.env.X_USER_ID;
const BASE = 'https://api.twitter.com/2';

if (!BEARER || !USER_ID) {
  console.log(JSON.stringify({ platform: 'x', error: 'Missing X_BEARER_TOKEN or X_USER_ID', posts: [], summary: {} }));
  process.exit(0);
}

const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${BEARER}`, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

try {
  const data = await fetchJson(
    `${BASE}/users/${USER_ID}/tweets?` +
    `tweet.fields=public_metrics,created_at,text,entities&` +
    `max_results=20&start_time=${sevenDaysAgo}&exclude=retweets,replies`
  );

  const posts = (data.data || []).map(t => ({
    id: t.id,
    timestamp: t.created_at,
    text_preview: t.text.slice(0, 100),
    metrics: {
      impressions: t.public_metrics?.impression_count || 0,
      likes: t.public_metrics?.like_count || 0,
      retweets: t.public_metrics?.retweet_count || 0,
      replies: t.public_metrics?.reply_count || 0,
      quotes: t.public_metrics?.quote_count || 0,
      clicks: t.public_metrics?.url_link_clicks || 0,
      engagement: (t.public_metrics?.like_count || 0) +
                  (t.public_metrics?.retweet_count || 0) +
                  (t.public_metrics?.reply_count || 0),
    },
  }));

  const totalImpressions = posts.reduce((s, p) => s + p.metrics.impressions, 0);
  const totalEngagement = posts.reduce((s, p) => s + p.metrics.engagement, 0);
  const avgEngRate = totalImpressions > 0 ? (totalEngagement / totalImpressions * 100).toFixed(2) : 0;
  const best = [...posts].sort((a, b) => b.metrics.engagement - a.metrics.engagement)[0];

  console.log(JSON.stringify({
    platform: 'x',
    period: '7d',
    posts,
    summary: {
      total_posts: posts.length,
      total_impressions: totalImpressions,
      total_engagement: totalEngagement,
      avg_engagement_rate_pct: parseFloat(avgEngRate),
      best_post_id: best?.id || null,
    },
  }));
} catch (err) {
  console.log(JSON.stringify({ platform: 'x', error: err.message, posts: [], summary: {} }));
}
