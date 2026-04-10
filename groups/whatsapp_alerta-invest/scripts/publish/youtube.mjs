#!/usr/bin/env node
// Publish YouTube Shorts — converts static image to 30s video via ffmpeg, then uploads
// Env: YOUTUBE_OAUTH_TOKEN, YOUTUBE_CHANNEL_ID
// Input (stdin): { imagePath, title, description, tags? }

import { execSync, spawnSync } from 'child_process';
import { readFileSync, createReadStream, statSync, unlinkSync } from 'fs';
import path from 'path';

const OAUTH_TOKEN = process.env.YOUTUBE_OAUTH_TOKEN;

if (!OAUTH_TOKEN) {
  console.log(JSON.stringify({ error: 'Missing YOUTUBE_OAUTH_TOKEN' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { imagePath, title, description, tags = [] } = input;

const videoPath = imagePath.replace(/\.png$/, '') + '-shorts.mp4';

try {
  // Step 1: Create 30s Ken Burns video from image using ffmpeg
  // Vertical format for Shorts: 1080x1920
  const ffmpegResult = spawnSync('ffmpeg', [
    '-loop', '1',
    '-i', imagePath,
    '-vf', 'scale=1080:1080,pad=1080:1920:0:420:black,zoompan=z=\'zoom+0.0005\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=750:s=1080x1920',
    '-c:v', 'libx264',
    '-t', '30',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-y',
    videoPath,
  ], { timeout: 60000 });

  if (ffmpegResult.status !== 0) {
    throw new Error(`ffmpeg failed: ${ffmpegResult.stderr?.toString()}`);
  }

  // Step 2: Upload to YouTube
  const videoSize = statSync(videoPath).size;

  // Initiate resumable upload
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OAUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': videoSize.toString(),
      },
      body: JSON.stringify({
        snippet: {
          title: title.slice(0, 100),
          description,
          tags: tags.slice(0, 15),
          categoryId: '25', // News & Politics
        },
        status: {
          privacyStatus: 'public',
          selfDeclaredMadeForKids: false,
        },
      }),
    }
  );

  if (!initRes.ok) throw new Error(`Upload init failed: ${await initRes.text()}`);

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('No upload URL returned');

  // Upload video bytes
  const videoBuffer = readFileSync(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': videoSize.toString(),
    },
    body: videoBuffer,
  });

  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(uploadData.error?.message || JSON.stringify(uploadData));

  const videoId = uploadData.id;
  try { unlinkSync(videoPath); } catch {}

  console.log(JSON.stringify({
    success: true,
    postId: videoId,
    url: `https://youtube.com/shorts/${videoId}`,
    platform: 'youtube',
  }));
} catch (err) {
  try { unlinkSync(videoPath); } catch {}
  console.log(JSON.stringify({ error: err.message, platform: 'youtube' }));
  process.exit(1);
}
