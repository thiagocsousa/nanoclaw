#!/usr/bin/env node
// YouTube analytics — last 7 days
// Env: YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID, YOUTUBE_OAUTH_TOKEN (optional, for analytics API)

const API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const OAUTH_TOKEN = process.env.YOUTUBE_OAUTH_TOKEN;

if (!API_KEY || !CHANNEL_ID) {
  console.log(JSON.stringify({ platform: 'youtube', error: 'Missing YOUTUBE_API_KEY or YOUTUBE_CHANNEL_ID', posts: [], summary: {} }));
  process.exit(0);
}

const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const BASE_DATA = 'https://www.googleapis.com/youtube/v3';
const BASE_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2';

async function fetchJson(url) {
  const res = await fetch(url, OAUTH_TOKEN ? { headers: { Authorization: `Bearer ${OAUTH_TOKEN}` } } : {});
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

try {
  // Get recent videos
  const searchData = await fetchJson(
    `${BASE_DATA}/search?channelId=${CHANNEL_ID}&type=video&order=date&maxResults=20` +
    `&publishedAfter=${sevenDaysAgo}&key=${API_KEY}&part=snippet`
  );

  const videoIds = (searchData.items || []).map(i => i.id.videoId).join(',');
  if (!videoIds) {
    console.log(JSON.stringify({ platform: 'youtube', period: '7d', posts: [], summary: { total_posts: 0 } }));
    process.exit(0);
  }

  // Get video statistics
  const statsData = await fetchJson(
    `${BASE_DATA}/videos?id=${videoIds}&part=statistics,snippet&key=${API_KEY}`
  );

  const posts = (statsData.items || []).map(v => ({
    id: v.id,
    timestamp: v.snippet?.publishedAt,
    title_preview: (v.snippet?.title || '').slice(0, 100),
    url: `https://youtube.com/watch?v=${v.id}`,
    metrics: {
      views: parseInt(v.statistics?.viewCount || 0),
      likes: parseInt(v.statistics?.likeCount || 0),
      comments: parseInt(v.statistics?.commentCount || 0),
      favorites: parseInt(v.statistics?.favoriteCount || 0),
      engagement: parseInt(v.statistics?.likeCount || 0) + parseInt(v.statistics?.commentCount || 0),
    },
  }));

  const totalViews = posts.reduce((s, p) => s + p.metrics.views, 0);
  const totalEngagement = posts.reduce((s, p) => s + p.metrics.engagement, 0);
  const avgEngRate = totalViews > 0 ? (totalEngagement / totalViews * 100).toFixed(2) : 0;
  const best = [...posts].sort((a, b) => b.metrics.views - a.metrics.views)[0];

  console.log(JSON.stringify({
    platform: 'youtube',
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
  console.log(JSON.stringify({ platform: 'youtube', error: err.message, posts: [], summary: {} }));
}
