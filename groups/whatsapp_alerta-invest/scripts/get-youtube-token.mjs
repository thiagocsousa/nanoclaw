#!/usr/bin/env node
// Generate YouTube OAuth refresh token — run once locally, save to OneCLI vault.
// Env: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET
// After running: copy YOUTUBE_REFRESH_TOKEN value to OneCLI.
//
// Before running:
//   1. Go to Google Cloud Console → APIs & Services → Credentials
//   2. Open your OAuth 2.0 Client ID
//   3. Add "http://localhost:3456/callback" to Authorized redirect URIs
//   4. Save

import http from 'http';
import { exec } from 'child_process';

const CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3456/callback';
const PORT          = 3456;

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET');
  console.error('Run: YOUTUBE_CLIENT_ID=xxx YOUTUBE_CLIENT_SECRET=yyy node scripts/get-youtube-token.mjs');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\nOpening browser for Google authorization...');
console.log(`\nIf it doesn't open, visit:\n${authUrl.toString()}\n`);

// Try to open in browser
const open = process.platform === 'darwin' ? 'open' : 'xdg-open';
exec(`${open} "${authUrl.toString()}"`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400);
    res.end(`<h1>Error: ${error}</h1>`);
    console.error(`\nAuthorization error: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end('<h1>Missing code</h1>');
    server.close();
    process.exit(1);
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      res.writeHead(500);
      res.end('<h1>No refresh token received. Try revoking access and re-running.</h1>');
      console.error('\nNo refresh token. Revoke access at https://myaccount.google.com/permissions and run again.');
      server.close();
      process.exit(1);
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Authorization complete. You can close this tab.</h1>');

    console.log('\n✓ Authorization complete!\n');
    console.log('Save this to OneCLI:');
    console.log(`  YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`\nExpires: never (refresh token is long-lived)`);

    server.close();
  } catch (err) {
    res.writeHead(500);
    res.end(`<h1>Error: ${err.message}</h1>`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Waiting for Google callback on port ${PORT}...`);
});
