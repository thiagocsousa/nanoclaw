#!/usr/bin/env node
// Reddit analytics — last 7 days
// Env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD

const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const USERNAME = process.env.REDDIT_USERNAME;
const PASSWORD = process.env.REDDIT_PASSWORD;

if (!CLIENT_ID || !CLIENT_SECRET || !USERNAME || !PASSWORD) {
  console.log(JSON.stringify({ platform: 'reddit', error: 'Missing Reddit credentials', posts: [], summary: {} }));
  process.exit(0);
}

async function getToken() {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AlertaInvest/1.0',
    },
    body: `grant_type=password&username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}&scope=read`,
  });
  const data = await res.json();
  return data.access_token;
}

try {
  const token = await getToken();

  const res = await fetch(
    `https://oauth.reddit.com/user/${USERNAME}/submitted?limit=25&t=week&sort=new`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'AlertaInvest/1.0',
      },
    }
  );
  const data = await res.json();

  const sevenDaysAgo = Date.now() / 1000 - 7 * 24 * 60 * 60;
  const posts = (data.data?.children || [])
    .filter(c => c.data.created_utc >= sevenDaysAgo)
    .map(c => ({
      id: c.data.id,
      timestamp: new Date(c.data.created_utc * 1000).toISOString(),
      title_preview: c.data.title.slice(0, 100),
      url: `https://reddit.com${c.data.permalink}`,
      subreddit: c.data.subreddit,
      metrics: {
        upvotes: c.data.ups,
        upvote_ratio: c.data.upvote_ratio,
        comments: c.data.num_comments,
        awards: c.data.total_awards_received,
        engagement: c.data.ups + c.data.num_comments,
      },
    }));

  const totalEngagement = posts.reduce((s, p) => s + p.metrics.engagement, 0);
  const best = [...posts].sort((a, b) => b.metrics.upvotes - a.metrics.upvotes)[0];

  console.log(JSON.stringify({
    platform: 'reddit',
    period: '7d',
    posts,
    summary: {
      total_posts: posts.length,
      total_engagement: totalEngagement,
      avg_upvotes: posts.length ? Math.round(posts.reduce((s, p) => s + p.metrics.upvotes, 0) / posts.length) : 0,
      best_post_id: best?.id || null,
      best_post_url: best?.url || null,
    },
  }));
} catch (err) {
  console.log(JSON.stringify({ platform: 'reddit', error: err.message, posts: [], summary: {} }));
}
