#!/usr/bin/env node
// TikTok analytics — last 7 days
// Env: TIKTOK_ACCESS_TOKEN

const TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const BASE = 'https://open.tiktokapis.com/v2';

if (!TOKEN) {
  console.log(JSON.stringify({ platform: 'tiktok', error: 'Missing TIKTOK_ACCESS_TOKEN', posts: [], summary: {} }));
  process.exit(0);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

try {
  // List videos
  const listData = await postJson(`${BASE}/video/list/?fields=id,create_time,title,video_description,share_url,statistics`, {
    max_count: 20,
  });

  const sevenDaysAgo = Date.now() / 1000 - 7 * 24 * 60 * 60;
  const allVideos = (listData.data?.videos || []).filter(v => v.create_time >= sevenDaysAgo);

  const posts = allVideos.map(v => ({
    id: v.id,
    timestamp: new Date(v.create_time * 1000).toISOString(),
    text_preview: (v.video_description || v.title || '').slice(0, 100),
    url: v.share_url,
    metrics: {
      views: v.statistics?.play_count || 0,
      likes: v.statistics?.like_count || 0,
      comments: v.statistics?.comment_count || 0,
      shares: v.statistics?.share_count || 0,
      engagement: (v.statistics?.like_count || 0) + (v.statistics?.comment_count || 0) + (v.statistics?.share_count || 0),
    },
  }));

  const totalViews = posts.reduce((s, p) => s + p.metrics.views, 0);
  const totalEngagement = posts.reduce((s, p) => s + p.metrics.engagement, 0);
  const avgEngRate = totalViews > 0 ? (totalEngagement / totalViews * 100).toFixed(2) : 0;
  const best = [...posts].sort((a, b) => b.metrics.views - a.metrics.views)[0];

  console.log(JSON.stringify({
    platform: 'tiktok',
    period: '7d',
    posts,
    summary: {
      total_posts: posts.length,
      total_views: totalViews,
      total_engagement: totalEngagement,
      avg_engagement_rate_pct: parseFloat(avgEngRate),
      best_post_id: best?.id || null,
    },
  }));
} catch (err) {
  console.log(JSON.stringify({ platform: 'tiktok', error: err.message, posts: [], summary: {} }));
}
