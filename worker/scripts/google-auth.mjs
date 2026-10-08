#!/usr/bin/env node
/**
 * One-time Google Calendar authorisation for the admin-site worker.
 *
 * Before running, create an OAuth client at
 *   https://console.cloud.google.com/apis/credentials
 *     - Enable the "Google Calendar API" for the project
 *     - Create credentials -> OAuth client ID -> Application type "Web application"
 *     - Add this Authorised redirect URI exactly:  http://localhost:8976/callback
 *
 * Then run:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-auth.mjs
 *
 * Open the printed URL, approve access, and the script prints the refresh
 * token. Store all three values on the worker:
 *   npx wrangler secret put GOOGLE_CLIENT_ID
 *   npx wrangler secret put GOOGLE_CLIENT_SECRET
 *   npx wrangler secret put GOOGLE_REFRESH_TOKEN
 */

import http from 'node:http';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/calendar';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment first.');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  // Force a fresh refresh token even if this client was approved before.
  prompt: 'consent',
});

async function exchange(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
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
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return res.json();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('Not found');
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Authorisation denied: ${error}`);
    console.error(`\nAuthorisation denied: ${error}`);
    server.close();
    process.exit(1);
  }

  try {
    const tokens = await exchange(url.searchParams.get('code'));
    res.writeHead(200, { 'Content-Type': 'text/html' })
      .end('<h2>Done.</h2><p>Refresh token printed in your terminal. You can close this tab.</p>');

    if (!tokens.refresh_token) {
      console.error('\nGoogle did not return a refresh token. Revoke the app at');
      console.error('https://myaccount.google.com/permissions and run this again.');
      server.close();
      process.exit(1);
    }

    console.log('\n--- GOOGLE_REFRESH_TOKEN ---');
    console.log(tokens.refresh_token);
    console.log('----------------------------\n');
    console.log('Now store the three secrets on the worker:');
    console.log('  npx wrangler secret put GOOGLE_CLIENT_ID');
    console.log('  npx wrangler secret put GOOGLE_CLIENT_SECRET');
    console.log('  npx wrangler secret put GOOGLE_REFRESH_TOKEN\n');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e.message));
    console.error('\n' + e.message);
  }
  server.close();
});

server.listen(PORT, () => {
  console.log('\nOpen this URL in your browser and approve access:\n');
  console.log(authUrl + '\n');
  console.log(`Waiting for the redirect to ${REDIRECT_URI} ...`);
});
