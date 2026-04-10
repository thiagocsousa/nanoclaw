---
name: social-pipeline
description: Full social media pipeline for Alerta Invest — analytics diagnosis, creative strategy with Flago signals, image generation, WhatsApp approval flow, publishing, and ad campaign creation across Instagram, X, TikTok, YouTube Shorts, and Reddit.
---

# /social-pipeline — Alerta Invest Daily Content Pipeline

Run when the daily cron fires (22:00 UTC) or when the user manually requests the pipeline.

---

## Agente 0: Analytics Diagnosis

Collect the last 7 days of post performance across all platforms. Run all analytics in parallel:

```bash
node /workspace/group/scripts/analytics/meta.mjs > /workspace/group/tmp/analytics-meta.json 2>&1 &
node /workspace/group/scripts/analytics/x.mjs > /workspace/group/tmp/analytics-x.json 2>&1 &
node /workspace/group/scripts/analytics/tiktok.mjs > /workspace/group/tmp/analytics-tiktok.json 2>&1 &
node /workspace/group/scripts/analytics/youtube.mjs > /workspace/group/tmp/analytics-youtube.json 2>&1 &
node /workspace/group/scripts/analytics/reddit.mjs > /workspace/group/tmp/analytics-reddit.json 2>&1 &
wait
```

Read all analytics files. Build a diagnosis object and save it:

```bash
cat /workspace/group/tmp/analytics-*.json
```

Save the combined diagnosis to `/workspace/group/diagnostico.json` with this structure:
```json
{
  "generated_at": "<ISO timestamp>",
  "period": "7d",
  "platforms": { "meta": {...}, "x": {...}, "tiktok": {...}, "youtube": {...}, "reddit": {...} },
  "top_platform": "<platform with best engagement rate>",
  "worst_platform": "<platform with lowest engagement rate>",
  "best_post": { "platform": "...", "id": "...", "engagement_rate": 0.0, "topic_hint": "..." },
  "insights": ["Insight 1", "Insight 2", "Insight 3"]
}
```

---

## Agente 1: Creative Strategy

### Step 1 — Fetch Flago Signals

```bash
node /workspace/group/scripts/flago.mjs > /workspace/group/tmp/flago-signals.json
cat /workspace/group/tmp/flago-signals.json
```

### Step 2 — Spawn strategy subagent

Spawn a subagent with this prompt (replace `{diagnostico}` and `{signals}` with actual content):

```
You are a social media strategist for Alerta Invest, a financial signals brand.

Your task: propose 4-6 social media creatives for today, distributed across 5 timezones (Asia/Tokyo 00:00 UTC, Asia/Kolkata 04:30 UTC, Europe/London 08:00 UTC, America/New_York 13:00 UTC, America/Los_Angeles 17:00 UTC). Max 6 posts/day total.

Rules:
- All content in English
- Focus: investment alerts, market movements, financial education
- Tone: authoritative, concise, data-driven
- Each creative must feel native to its platform
- Ads proposal must be realistic (Meta min $1/day, X min $3/day, TikTok min $20/day)

For each creative output a JSON object:
{
  "id": 1,
  "tema": "Short topic title",
  "rationale": "Why this topic today (signal + performance data)",
  "flago_signal": { "ticker": "...", "type": "...", "strength": 0-10 },
  "image_spec": {
    "ticker": "...",
    "signal_type": "BUY|SELL|ALERT|WATCH",
    "headline": "Max 8 words",
    "body": "Max 15 words",
    "cta": "Max 4 words",
    "accent_color": "#hex (green for buy, red for sell, amber for alert, blue for watch)"
  },
  "platforms": {
    "instagram": { "caption": "...", "hashtags": [...], "post_time_utc": "...", "timezone_label": "..." },
    "x": { "text": "Max 280 chars with $TICKER", "post_time_utc": "..." },
    "tiktok": { "text": "Hook + body, max 150 chars", "post_time_utc": "..." },
    "youtube": { "title": "Max 60 chars", "description": "...", "tags": [...], "post_time_utc": "..." },
    "reddit": { "title": "...", "body": "...", "subreddit": "investing or stocks or forex", "post_time_utc": "..." }
  },
  "ads": {
    "instagram": { "objective": "TRAFFIC|ENGAGEMENT|CONVERSIONS", "audience": { "interests": [...], "age_min": 25, "age_max": 55, "geos": [...] }, "daily_budget_usd": 10, "duration_days": 3 },
    "x": { "objective": "...", "audience": {...}, "daily_budget_usd": 5, "duration_days": 3 },
    "tiktok": { "objective": "...", "audience": {...}, "daily_budget_usd": 20, "duration_days": 2 },
    "reddit": { "objective": "...", "audience": { "subreddits": [...] }, "daily_budget_usd": 5, "duration_days": 3 }
  }
}

Output a JSON array of all creatives. Nothing else.

Analytics diagnosis:
{diagnostico}

Flago signals:
{signals}
```

Save the subagent's JSON output to `/workspace/group/criativos.json` with wrapper:
```json
{
  "generated_at": "<ISO>",
  "pending_approval": true,
  "approved": [],
  "criativos": [... subagent output ...]
}
```

---

## Agente 2: Copy + Image Generation

For each creative in `criativos.json`, generate the image:

```bash
mkdir -p /workspace/group/tmp/images

node /workspace/group/scripts/generate-image.mjs << 'EOF'
{
  "ticker": "...",
  "signalType": "ALERT",
  "headline": "...",
  "body": "...",
  "cta": "...",
  "accentColor": "#F5A623",
  "outputPath": "/workspace/group/tmp/images/creative-1.png"
}
EOF
```

Run image generation for each creative. Store path in `criativos.json` under each creative: `"image_path": "/workspace/group/tmp/images/creative-N.png"`.

---

## WhatsApp Approval Message

After all images are generated, send the approval message using `mcp__nanoclaw__send_message`:

Format each creative as:
```
*[N]. [tema]*
📍 _[platforms + UTC times]_
💬 [X text preview, max 60 chars]
💰 Ads: $[total daily budget] • [top objective]

```

End with:
```
Respond *SIM* to publish all, *SIM 1,3* to select, or *EDIT N* to adjust.
```

---

## Agente 3: Publisher (runs after approval)

For each approved creative, upload the image and publish to each platform:

### Step 1 — Upload image to Cloudinary

```bash
node /workspace/group/scripts/upload-image.mjs << EOF
{ "imagePath": "/workspace/group/tmp/images/creative-N.png" }
EOF
```

Returns `{ "url": "https://res.cloudinary.com/..." }`. Store URL in the creative.

### Step 2 — Publish to each platform

```bash
# Instagram
node /workspace/group/scripts/publish/meta.mjs << EOF
{ "imageUrl": "...", "caption": "...", "hashtags": [...] }
EOF

# X/Twitter
node /workspace/group/scripts/publish/x.mjs << EOF
{ "text": "...", "imagePath": "/workspace/group/tmp/images/creative-N.png" }
EOF

# TikTok
node /workspace/group/scripts/publish/tiktok.mjs << EOF
{ "imageUrl": "...", "text": "..." }
EOF

# YouTube Shorts (converts image to 30s video via ffmpeg)
node /workspace/group/scripts/publish/youtube.mjs << EOF
{ "imagePath": "...", "title": "...", "description": "...", "tags": [...] }
EOF

# Reddit
node /workspace/group/scripts/publish/reddit.mjs << EOF
{ "subreddit": "...", "title": "...", "body": "...", "imageUrl": "..." }
EOF
```

Each script returns `{ "success": true, "postId": "...", "url": "..." }`. Save results.

---

## Agente 4: Ads Creator (runs after each publish succeeds)

Create ad campaigns using the published post IDs:

```bash
# Meta Ads
node /workspace/group/scripts/ads/meta.mjs << EOF
{ "postId": "...", "objective": "TRAFFIC", "audience": {...}, "dailyBudgetUsd": 10, "durationDays": 3 }
EOF

# X Ads
node /workspace/group/scripts/ads/x.mjs << EOF
{ "tweetId": "...", "objective": "...", "audience": {...}, "dailyBudgetUsd": 5, "durationDays": 3 }
EOF

# TikTok Ads
node /workspace/group/scripts/ads/tiktok.mjs << EOF
{ "postId": "...", "objective": "TRAFFIC", "audience": {...}, "dailyBudgetUsd": 20, "durationDays": 2 }
EOF

# Google Ads (YouTube)
node /workspace/group/scripts/ads/google.mjs << EOF
{ "videoId": "...", "objective": "...", "audience": {...}, "dailyBudgetUsd": 10, "durationDays": 3 }
EOF

# Reddit Ads
node /workspace/group/scripts/ads/reddit.mjs << EOF
{ "postId": "...", "subreddit": "...", "audience": {...}, "dailyBudgetUsd": 5, "durationDays": 3 }
EOF
```

---

## Final Report

After all publishing and ads are complete, send summary via `mcp__nanoclaw__send_message`:

```
*Pipeline Complete*

✅ [N] posts published
✅ [N] ad campaigns created
💸 Total daily ad spend: $XX

[per creative summary with links]
```
