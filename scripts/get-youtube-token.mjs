#!/usr/bin/env node
// Helper: generate YouTube OAuth refresh token
// Uses existing Google OAuth client (same project as Google Ads)
// Run: node scripts/get-youtube-token.mjs
// Then visit the URL, authorize, paste the code back

import { createServer } from 'http';
import { URL } from 'url';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID     || process.argv[2];
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || process.argv[3];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: YOUTUBE_CLIENT_ID=xxx YOUTUBE_CLIENT_SECRET=yyy node scripts/get-youtube-token.mjs');
  console.error('   or: node scripts/get-youtube-token.mjs <client_id> <client_secret>');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:8089';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
];

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\n=== YouTube OAuth Setup ===');
console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl.toString());
console.log('\n2. Authorize the Flago YouTube account');
console.log('3. You will be redirected — this script will capture the code automatically\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8089');
  if (!url.searchParams.get('code')) { res.end(); return; }

  const code = url.searchParams.get('code');
  if (!code) {
    res.end('No code received.');
    console.error('No code in callback URL');
    process.exit(1);
  }

  res.end('<h2>Success! You can close this tab.</h2>');

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  server.close();

  if (!tokens.refresh_token) {
    console.error('\nERROR: No refresh_token received. Response:', JSON.stringify(tokens, null, 2));
    console.error('\nTip: make sure you revoke access at https://myaccount.google.com/permissions and try again.');
    process.exit(1);
  }

  // Fetch channel ID
  let channelId = '(fetch failed)';
  try {
    const chRes = await fetch(
      'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    const chData = await chRes.json();
    const ch = chData.items?.[0];
    if (ch) {
      channelId = ch.id;
      console.log(`\nChannel found: ${ch.snippet?.title} (${channelId})`);
    }
  } catch (e) {
    console.error('Could not fetch channel ID:', e.message);
  }

  // Save to OneCLI vault automatically
  let savedToVault = false;
  try {
    execSync(`onecli set YOUTUBE_CLIENT_ID "${CLIENT_ID}"`, { stdio: 'ignore' });
    execSync(`onecli set YOUTUBE_CLIENT_SECRET "${CLIENT_SECRET}"`, { stdio: 'ignore' });
    execSync(`onecli set YOUTUBE_REFRESH_TOKEN "${tokens.refresh_token}"`, { stdio: 'ignore' });
    if (channelId !== '(fetch failed)') execSync(`onecli set YOUTUBE_CHANNEL_ID "${channelId}"`, { stdio: 'ignore' });
    savedToVault = true;
  } catch (_) {}

  console.log('\n=== SUCCESS ===\n');
  if (savedToVault) {
    console.log('Credentials saved to OneCLI vault automatically.');
  } else {
    console.log('Could not save to OneCLI — add manually:\n');
    console.log(`  onecli set YOUTUBE_CLIENT_ID "${CLIENT_ID}"`);
    console.log(`  onecli set YOUTUBE_CLIENT_SECRET "${CLIENT_SECRET}"`);
    console.log(`  onecli set YOUTUBE_REFRESH_TOKEN "${tokens.refresh_token}"`);
    console.log(`  onecli set YOUTUBE_CHANNEL_ID "${channelId}"`);
  }
  console.log(`\nChannel ID: ${channelId}`);
  console.log('Done!\n');
  process.exit(0);
});

server.listen(8089, () => {
  console.log('Waiting for OAuth callback on http://localhost:8089/callback ...\n');
});
