#!/usr/bin/env node
// Generate animated video from Flago creative (story PNG → MP4)
// Used for TikTok and YouTube Shorts (1080×1920, 15s)
//
// Input (stdin): {
//   imagePath: string,     // absolute path to story PNG (1080×1920)
//   outputPath?: string,   // default: same dir, .mp4 extension
//   duration?: number,     // seconds, default: 15
//   animation?: 'cinematic' | 'ken-burns',  // default: 'cinematic'
// }
//
// cinematic (default): 3-phase camera sequence
//   Phase 1 — zoom out from 1.3→1.0, anchored to headline (top)
//   Phase 2 — zoom in from 1.0→1.2, anchored to center (stats)
//   Phase 3 — slow pull from 1.2→1.1, anchored to bottom (markets/CTA)
//   Crossfade between phases (0.5s dissolve)
//
// ken-burns: simple center zoom-in (original)

import { execSync } from 'child_process';
import { mkdirSync, readFileSync } from 'fs';
import path from 'path';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { imagePath, duration = 15, animation = 'glide' } = input;

if (!imagePath) {
  console.log(JSON.stringify({ error: 'imagePath is required' }));
  process.exit(1);
}

const outputPath = input.outputPath || imagePath.replace(/\.(png|jpg|jpeg)$/i, '.mp4');
mkdirSync(path.dirname(outputPath), { recursive: true });

const fps = 30;

let cmd;

if (animation === 'scan') {
  // ── Scan: header + footer fixed; only the signal list area pans top→bottom ─
  // headerH / footerH can be overridden via input (auto-detected defaults below).
  const headerH = input.headerH ?? 140;          // px — below topbar separator
  const footerY = input.footerY ?? 1860;          // px — where footer begins
  const midH    = footerY - headerH;              // 1720px of scrollable area
  const scaleH  = Math.round(midH * 1.30);        // 2236px scaled
  const travelY = scaleH - midH;                  // 516px travel

  const filterComplex = [
    // Static base (full image, header + footer always visible)
    `[0:v]setsar=1[base]`,
    // Middle section only: extract → scale up 30% → pan top→bottom
    `[0:v]crop=w=1080:h=${midH}:x=0:y=${headerH},scale=1080:${scaleH},crop=w=1080:h=${midH}:x=0:y='${travelY}*t/${duration}',setsar=1[mid]`,
    // Overlay animated middle onto base, header and footer untouched
    `[base][mid]overlay=x=0:y=${headerH}[out]`,
  ].join(';');

  cmd = [
    FFMPEG, '-y',
    `-loop 1`, `-framerate ${fps}`, `-i "${imagePath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[out]"`,
    `-t ${duration}`,
    '-c:v libx264', '-preset fast', '-crf 23', '-pix_fmt yuv420p', '-an',
    '-movflags +faststart',
    `"${outputPath}"`,
    '2>/dev/null',
  ].join(' ');

} else if (animation === 'reveal') {
  // ── Reveal: extreme zoom-in (3×) pulls back to full card over 9s, holds ──
  // Anchored to top-center (where the first ticker row sits).
  // After zoom reaches 1.0, the card stays static for the rest.
  const totalFrames = duration * fps;
  const zoomFrames  = Math.round(9 * fps);  // 9s pull-back

  const zpFilter = [
    `zoompan=z='max(1.0, 3.0 - 2.0*on/${zoomFrames})'`,
    `d=${totalFrames}`,
    `fps=${fps}`,
    `x='iw/2-(iw/zoom/2)'`,
    `y='ih*0.25-(ih/zoom*0.25)'`,
    `s=1080x1920`,
  ].join(':');
  const vf = `${zpFilter},setsar=1`;

  cmd = [
    FFMPEG, '-y',
    '-loop 1', `-framerate 1`, `-i "${imagePath}"`,
    `-vf "${vf}"`,
    `-t ${duration}`,
    '-c:v libx264', '-preset fast', '-crf 23', '-pix_fmt yuv420p', '-an',
    '-movflags +faststart',
    `"${outputPath}"`,
    '2>/dev/null',
  ].join(' ');

} else if (animation === 'glide') {
  // ── Glide: gentle horizontal drift, full content always readable ─────────
  // Scale up 12%, pan left→right over the full duration. No zoom = no blur.
  // Travel distance: 1080 * 0.12 = 129px over 15s (8.6px/s, imperceptible).
  const scaleW = Math.round(1080 * 1.12);
  const scaleH = Math.round(1920 * 1.12);
  const travelX = scaleW - 1080;   // 129px
  const cropY   = Math.floor((scaleH - 1920) / 2);  // vertically centered

  const vf = [
    `scale=${scaleW}:${scaleH}`,
    `crop=w=1080:h=1920:x='${travelX}*t/${duration}':y=${cropY}`,
    `setsar=1`,
  ].join(',');

  cmd = [
    FFMPEG, '-y',
    '-loop 1', `-framerate ${fps}`, `-i "${imagePath}"`,
    `-vf "${vf}"`,
    `-t ${duration}`,
    '-c:v libx264', '-preset fast', '-crf 23', '-pix_fmt yuv420p', '-an',
    '-movflags +faststart',
    `"${outputPath}"`,
    '2>/dev/null',
  ].join(' ');

} else if (animation === 'breathe') {
  // ── Breathe: sin zoom 1.0→1.04→1.0, one cycle, anchored center ──────────
  // Half-sine curve over full duration — subtle pulse, premium/calm feel.
  const totalFrames = duration * fps;
  const zpFilter = [
    `zoompan=z='1.0+0.04*sin(3.14159*on/${totalFrames})'`,
    `d=${totalFrames}`,
    `fps=${fps}`,
    `x='iw/2-(iw/zoom/2)'`,
    `y='ih/2-(ih/zoom/2)'`,
    `s=1080x1920`,
  ].join(':');

  cmd = [
    FFMPEG, '-y',
    '-loop 1', `-framerate 1`, `-i "${imagePath}"`,
    `-vf "${zpFilter},setsar=1"`,
    `-t ${duration}`,
    '-c:v libx264', '-preset fast', '-crf 23', '-pix_fmt yuv420p', '-an',
    '-movflags +faststart',
    `"${outputPath}"`,
    '2>/dev/null',
  ].join(' ');

} else if (animation === 'flash') {
  // ── Flash: zoom-in 1.0→1.3 on headline (top) in 1.5s, pull back in 5s, hold ─
  // Puts the headline in frame first, then reveals the full card.
  const totalFrames = duration * fps;
  const f1 = Math.round(1.5 * fps);        // end zoom-in  (frame 45)
  const f2 = Math.round(6.5 * fps);        // end pull-back (frame 195)
  const delta = f2 - f1;

  const zpFilter = [
    `zoompan=z='if(lte(on,${f1}),1.0+0.3*(on/${f1}),if(lte(on,${f2}),1.3-0.3*((on-${f1})/${delta}),1.0))'`,
    `d=${totalFrames}`,
    `fps=${fps}`,
    `x='iw/2-(iw/zoom/2)'`,
    `y='0'`,
    `s=1080x1920`,
  ].join(':');

  cmd = [
    FFMPEG, '-y',
    '-loop 1', `-framerate 1`, `-i "${imagePath}"`,
    `-vf "${zpFilter},setsar=1"`,
    `-t ${duration}`,
    '-c:v libx264', '-preset fast', '-crf 23', '-pix_fmt yuv420p', '-an',
    '-movflags +faststart',
    `"${outputPath}"`,
    '2>/dev/null',
  ].join(' ');

} else if (animation === 'ken-burns') {
  // ── Simple center zoom-in ────────────────────────────────────────────────
  const frames = duration * fps;
  const zoomMax = 1.25;
  const zoomInc = ((zoomMax - 1.0) / frames).toFixed(7);
  const vf = [
    `zoompan=z='min(zoom+${zoomInc},${zoomMax})'`,
    `d=${frames}`,
    `x='iw/2-(iw/zoom/2)'`,
    `y='ih/2-(ih/zoom/2)'`,
    `s=1080x1920`,
  ].join(':');

  cmd = [
    FFMPEG, '-y',
    '-loop 1', `-framerate ${fps}`, `-i "${imagePath}"`,
    `-vf "${vf},setsar=1"`,
    `-t ${duration}`,
    '-c:v libx264', '-preset fast', '-crf 23', '-pix_fmt yuv420p', '-an',
    '-movflags +faststart',
    `"${outputPath}"`,
    '2>/dev/null',
  ].join(' ');

} else {
  // ── Cinematic 3-phase sequence ──────────────────────────────────────────
  // Each phase: duration/3 + 0.5s overlap for crossfade
  // xfade at 1/3 and 2/3 of total duration, dissolve 0.5s
  const phaseLen = (duration / 3 + 0.5).toFixed(2);   // e.g. 5.50s each
  const xfade1   = (duration / 3).toFixed(2);           // offset for 1st crossfade
  const xfade2   = (duration * 2 / 3).toFixed(2);       // offset for 2nd crossfade
  const phaseFps = Math.ceil(parseFloat(phaseLen) * fps);

  // Phase 1: zoom out 1.3→1.0, top anchor (headline)
  const zp1 = [
    `zoompan=z='max(1.0,1.3-0.3*on/${phaseFps})'`,
    `d=${phaseFps}`,
    `fps=${fps}`,
    `x='iw/2-(iw/zoom/2)'`,
    `y='0'`,
    `s=1080x1920`,
  ].join(':');

  // Phase 2: zoom in 1.0→1.2, center anchor (stats row)
  const zp2 = [
    `zoompan=z='min(1.2,1.0+0.2*on/${phaseFps})'`,
    `d=${phaseFps}`,
    `fps=${fps}`,
    `x='iw/2-(iw/zoom/2)'`,
    `y='ih/2-(ih/zoom/2)'`,
    `s=1080x1920`,
  ].join(':');

  // Phase 3: slow pull 1.2→1.1, bottom anchor (markets + CTA)
  const zp3 = [
    `zoompan=z='max(1.1,1.2-0.1*on/${phaseFps})'`,
    `d=${phaseFps}`,
    `fps=${fps}`,
    `x='iw/2-(iw/zoom/2)'`,
    `y='max(0,ih-ih/zoom)'`,
    `s=1080x1920`,
  ].join(':');

  const filterComplex = [
    `[0:v]${zp1},setsar=1,setpts=PTS-STARTPTS[v0]`,
    `[1:v]${zp2},setsar=1,setpts=PTS-STARTPTS[v1]`,
    `[2:v]${zp3},setsar=1,setpts=PTS-STARTPTS[v2]`,
    `[v0][v1]xfade=transition=fade:duration=0.5:offset=${xfade1}[t01]`,
    `[t01][v2]xfade=transition=fade:duration=0.5:offset=${xfade2}[out]`,
  ].join(';');

  cmd = [
    FFMPEG, '-y',
    // 3 identical inputs (one per phase)
    `-loop 1 -t ${phaseLen} -framerate ${fps} -i "${imagePath}"`,
    `-loop 1 -t ${phaseLen} -framerate ${fps} -i "${imagePath}"`,
    `-loop 1 -t ${phaseLen} -framerate ${fps} -i "${imagePath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[out]"`,
    `-t ${duration}`,
    '-c:v libx264', '-preset fast', '-crf 23', '-pix_fmt yuv420p', '-an',
    '-movflags +faststart',
    `"${outputPath}"`,
    '2>/dev/null',
  ].join(' ');
}

try {
  execSync(cmd, { timeout: 180000 });
  console.log(JSON.stringify({
    success: true,
    path: outputPath,
    duration,
    animation,
    format: '1080x1920',
    codec: 'h264',
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
