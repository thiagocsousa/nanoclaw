#!/usr/bin/env node
// Publish image post to Instagram via Meta Graph API
// Env: INSTAGRAM_BUSINESS_ACCOUNT_ID, META_ACCESS_TOKEN
// Input (stdin): { imageUrl, caption, hashtags? }

import { readFileSync } from 'fs';

const IG_USER_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const TOKEN = process.env.META_ACCESS_TOKEN;
const BASE = 'https://graph.facebook.com/v20.0';

if (!IG_USER_ID || !TOKEN) {
  console.log(JSON.stringify({ error: 'Missing INSTAGRAM_BUSINESS_ACCOUNT_ID or META_ACCESS_TOKEN' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { imageUrl, caption, hashtags = [] } = input;

const fullCaption = hashtags.length
  ? `${caption}\n\n${hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')}`
  : caption;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data;
}

try {
  // Step 1: Create media container
  const container = await postJson(`${BASE}/${IG_USER_ID}/media`, {
    image_url: imageUrl,
    caption: fullCaption,
    access_token: TOKEN,
  });

  if (!container.id) throw new Error('No container ID returned');

  // Wait for container to be ready
  await new Promise(r => setTimeout(r, 5000));

  // Check status
  const statusRes = await fetch(
    `${BASE}/${container.id}?fields=status_code&access_token=${TOKEN}`
  );
  const status = await statusRes.json();
  if (status.status_code && status.status_code !== 'FINISHED') {
    throw new Error(`Container not ready: ${status.status_code}`);
  }

  // Step 2: Publish
  const published = await postJson(`${BASE}/${IG_USER_ID}/media_publish`, {
    creation_id: container.id,
    access_token: TOKEN,
  });

  const postUrl = `https://www.instagram.com/p/${published.id}/`;
  console.log(JSON.stringify({ success: true, postId: published.id, url: postUrl, platform: 'instagram' }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'instagram' }));
  process.exit(1);
}
