#!/usr/bin/env node
// Submit post to Reddit
// Env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
// Input (stdin): { subreddit, title, body?, imageUrl? }

import { readFileSync } from 'fs';

const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const USERNAME = process.env.REDDIT_USERNAME;
const PASSWORD = process.env.REDDIT_PASSWORD;

if (!CLIENT_ID || !CLIENT_SECRET || !USERNAME || !PASSWORD) {
  console.log(JSON.stringify({ error: 'Missing Reddit credentials' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { subreddit, title, body = '', imageUrl } = input;

async function getToken() {
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AlertaInvest/1.0',
    },
    body: `grant_type=password&username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}&scope=submit`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

try {
  const token = await getToken();

  const params = new URLSearchParams({
    sr: subreddit,
    title,
    kind: imageUrl ? 'link' : 'self',
    ...(imageUrl ? { url: imageUrl } : { text: body }),
    resubmit: 'true',
    nsfw: 'false',
    spoiler: 'false',
  });

  const res = await fetch('https://oauth.reddit.com/api/submit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'AlertaInvest/1.0',
    },
    body: params,
  });
  const data = await res.json();

  const postUrl = data?.jquery?.find?.(r => Array.isArray(r) && r.some(x => typeof x === 'string' && x.includes('reddit.com/r/')))
    ?.[3]?.[0] || data?.data?.url;

  if (!res.ok || data.error) throw new Error(data.error || JSON.stringify(data));

  console.log(JSON.stringify({ success: true, url: postUrl || `https://reddit.com/r/${subreddit}`, platform: 'reddit' }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'reddit' }));
  process.exit(1);
}
