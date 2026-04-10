#!/usr/bin/env node
// Post tweet with image to X/Twitter via API v2
// Env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
// Input (stdin): { text, imagePath? }

import { createHmac } from 'crypto';
import { readFileSync } from 'fs';

const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const ACCESS_SECRET = process.env.X_ACCESS_SECRET;

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_SECRET) {
  console.log(JSON.stringify({ error: 'Missing X OAuth credentials' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { text, imagePath } = input;

function oauthSign(method, url, params) {
  const nonce = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: ACCESS_TOKEN,
    oauth_version: '1.0',
    ...params,
  };

  const sortedParams = Object.keys(oauthParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(oauthParams[k])}`)
    .join('&');

  const baseString = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(sortedParams)].join('&');
  const signingKey = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(ACCESS_SECRET)}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  oauthParams.oauth_signature = signature;

  const authHeader = 'OAuth ' + Object.keys(oauthParams)
    .filter(k => k.startsWith('oauth_'))
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return authHeader;
}

async function uploadMedia(imagePath) {
  const imageBuffer = readFileSync(imagePath);
  const base64 = imageBuffer.toString('base64');

  const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
  const params = { media_data: base64 };
  const authHeader = oauthSign('POST', uploadUrl, {});

  const form = new URLSearchParams();
  form.append('media_data', base64);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errors?.[0]?.message || JSON.stringify(data));
  return data.media_id_string;
}

try {
  const tweetUrl = 'https://api.twitter.com/2/tweets';
  const body = { text };

  if (imagePath) {
    const mediaId = await uploadMedia(imagePath);
    body.media = { media_ids: [mediaId] };
  }

  const authHeader = oauthSign('POST', tweetUrl, {});

  const res = await fetch(tweetUrl, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || data.errors?.[0]?.message || JSON.stringify(data));

  const tweetId = data.data?.id;
  const tweetUrl2 = `https://x.com/i/web/status/${tweetId}`;
  console.log(JSON.stringify({ success: true, postId: tweetId, url: tweetUrl2, platform: 'x' }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message, platform: 'x' }));
  process.exit(1);
}
