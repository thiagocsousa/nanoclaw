#!/usr/bin/env node
// Helper: generate LinkedIn OAuth refresh token (w_member_social)
// Run: node scripts/get-linkedin-token.mjs
// Visit the URL, authorize, and the script saves to .env automatically

import { createServer } from 'http';
import { URL } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const envPath = new URL('../.env', import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const CLIENT_ID     = process.env.LINKEDIN_CLIENT_ID     || env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || env.LINKEDIN_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET not found in .env');
  process.exit(1);
}

const REDIRECT_URI = 'http://localhost:8089';
const SCOPE        = 'w_member_social r_liteprofile';

const authUrl = new URL('https://www.linkedin.com/oauth/v2/authorization');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', 'w_member_social openid profile');
authUrl.searchParams.set('state', Math.random().toString(36).slice(2));

console.log('\n=== LinkedIn OAuth Setup ===');
console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl.toString());
console.log('\n2. Authorize with your LinkedIn account');
console.log('3. You will be redirected — this script captures the code automatically\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8089');
  const code = url.searchParams.get('code');
  if (!code) { res.end(); return; }

  res.end('<h2>Success! You can close this tab.</h2>');

  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  const tokens = await tokenRes.json();
  server.close();

  if (!tokens.refresh_token && !tokens.access_token) {
    console.error('\nERROR:', JSON.stringify(tokens, null, 2));
    process.exit(1);
  }

  // Fetch person ID via OpenID Connect userinfo
  let personId = '';
  try {
    const uiRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const ui = await uiRes.json();
    personId = ui.sub || '';
    if (personId) console.log(`\nPerson ID: ${personId} | Name: ${ui.name || ''}`);
  } catch (_) {}

  // Update .env
  let envContent = readFileSync(envPath, 'utf8');
  const refreshToken = tokens.refresh_token || '';
  const accessToken  = tokens.access_token  || '';

  if (refreshToken) {
    if (envContent.includes('LINKEDIN_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/LINKEDIN_REFRESH_TOKEN=.*/, `LINKEDIN_REFRESH_TOKEN=${refreshToken}`);
    } else {
      envContent += `\nLINKEDIN_REFRESH_TOKEN=${refreshToken}`;
    }
  }
  if (accessToken) {
    if (envContent.includes('LINKEDIN_ACCESS_TOKEN=')) {
      envContent = envContent.replace(/LINKEDIN_ACCESS_TOKEN=.*/, `LINKEDIN_ACCESS_TOKEN=${accessToken}`);
    } else {
      envContent += `\nLINKEDIN_ACCESS_TOKEN=${accessToken}`;
    }
  }
  if (personId) {
    if (envContent.includes('LINKEDIN_PERSON_ID=')) {
      envContent = envContent.replace(/LINKEDIN_PERSON_ID=.*/, `LINKEDIN_PERSON_ID=${personId}`);
    } else {
      envContent += `\nLINKEDIN_PERSON_ID=${personId}`;
    }
  }
  writeFileSync(envPath, envContent);

  console.log('\n=== SUCCESS ===\n');
  console.log('Credentials saved to .env');
  if (refreshToken) console.log(`LINKEDIN_REFRESH_TOKEN expires in: ${Math.round((tokens.refresh_token_expires_in || 0) / 86400)} days`);
  console.log(`LINKEDIN_ACCESS_TOKEN expires in: ${Math.round((tokens.expires_in || 0) / 3600)}h`);
  console.log('\nDone!\n');
  process.exit(0);
});

server.listen(8089, () => {
  console.log('Waiting for OAuth callback on http://localhost:8089 ...\n');
});
