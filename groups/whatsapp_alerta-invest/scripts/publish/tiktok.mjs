#!/usr/bin/env node
// Publish image post to TikTok via Content Posting API
// Env: TIKTOK_ACCESS_TOKEN
// Input (stdin): { imageUrl, text }

import { readFileSync } from 'fs';

const TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const BASE = 'https://open.tiktokapis.com/v2';

if (!TOKEN) {
  console.log(JSON.stringify({ error: 'Missing TIKTOK_ACCESS_TOKEN' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { imageUrl, text } = input;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error?.code !== 'ok') {
    throw new Error(data.error?.message || JSON.stringify(data));
  }
  return data;
}

try {
  // Initialize photo post
  const initData = await postJson(`${BASE}/post/publish/content/init/`, {
    post_info: {
      title: text,
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      auto_add_music: true,
    },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: [imageUrl],
    },
    post_mode: 'DIRECT_POST',
    media_type: 'PHOTO',
  });

  const publishId = initData.data?.publish_id;
  if (!publishId) throw new Error('No publish_id returned');

  // Poll for status
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusData = await postJson(`${BASE}/post/publish/status/fetch/`, { publish_id: publishId });
    const status = statusData.data?.status;
    if (status === 'PUBLISH_COMPLETE') {
      const shareUrl = `https://www.tiktok.com/@${process.env.TIKTOK_USERNAME || 'me'}`;
      console.log(JSON.stringify({ success: true, postId: publishId, url: shareUrl, platform: 'tiktok' }));
      process.exit(0);
    }
    if (status === 'FAILED') throw new Error(`TikTok publish failed: ${JSON.stringify(statusData)}`);
  }
  throw new Error('TikTok publish timed out');
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'tiktok' }));
  process.exit(1);
}
