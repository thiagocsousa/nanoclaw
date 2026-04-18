#!/usr/bin/env node
// Idempotent cron seeder — upserts scheduled_tasks rows into the local DB.
// Safe to run multiple times: existing rows are updated, new ones inserted.
// Called by deploy.sh after build.
//
// To add/change crons: edit the CRONS array below and redeploy.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'store', 'messages.db');

const APPROVAL_JID = '558681512111@s.whatsapp.net';

// ── Prompt helpers ────────────────────────────────────────────────────────────

const midPrompt = (sessionLabel, session, adTargets) => `\
Mid-session run — ${sessionLabel} (UTC).

**Step 0 — Check rotation state**
Read /workspace/group/pipeline-state.json (if missing, treat all dates as epoch 0 and next_targets as "europe_mid").

Evaluate in order:
1. If days_since(promo_last_run) >= 7 AND promo_next_target == "${session}_mid" → run PROMO pipeline (see CLAUDE.md Rotation section). Update state: promo_last_run=now, flip promo_next_target to "${session === 'europe' ? 'americas' : 'europe'}_mid".
2. Elif days_since(news_last_run) >= 2 AND news_next_target == "${session}_mid" → run NEWS pipeline (see CLAUDE.md Rotation section). Update state: news_last_run=now, flip news_next_target to "${session === 'europe' ? 'americas' : 'europe'}_mid".
3. Else → run regular signals pipeline.

**Regular signals pipeline:**
/social-pipeline session=mid sessionLabel="${sessionLabel}" adTargets=${adTargets}`;

const SATURDAY_PROMPT = `\
Weekly recap — Saturday (10:00 UTC).

Fetch recent signals to build a data-driven week-in-review post:
\`\`\`
FLAGO_LIMIT=50 node scripts/flago.mjs
\`\`\`

Use the returned signals (real API data only — never invent) to create a "Week in Review" creative:
- sessionLabel: "Week in Review"
- Pick the 6 most notable signals from the response (mix bullish/bearish, spread across indices)
- Generate all 3 image formats + video:
  square: /workspace/group/tmp/images/creative-square-recap.png
  story:  /workspace/group/tmp/images/creative-story-recap.png
  landscape: /workspace/group/tmp/images/creative-landscape-recap.png
  video (Ken Burns from story): /workspace/group/tmp/images/creative-video-recap.mp4

Caption style: "This week's top signals across global markets."

Send square image to WhatsApp for approval. No ad campaigns for recap posts.`;

const SUNDAY_PROMPT = `\
Sunday post (14:00 UTC).

Read /workspace/group/pipeline-state.json (if missing, treat all dates as epoch 0).

Evaluate:
1. If days_since(promo_last_run) >= 7 → run PROMO pipeline (see CLAUDE.md Rotation section). Update state: promo_last_run=now.
2. Else → run NEWS pipeline (see CLAUDE.md Rotation section). Update state: news_last_run=now.

Sunday is not part of the mid-session alternating rotation — it picks whichever is due without flipping promo_next_target or news_next_target.`;

// ── Cron definitions ──────────────────────────────────────────────────────────

const CRONS = [
  {
    id: 'flago-cron-asia-early',
    schedule_value: '30 21 * * 0-4',  // 00:30 UTC Mon–Fri
    prompt: '/social-pipeline session=open sessionLabel="Asia Early Open" adTargets=JP,KR,AU',
  },
  {
    id: 'flago-cron-asia-late',
    schedule_value: '0 1 * * 1-5',    // 04:00 UTC Mon–Fri
    prompt: '/social-pipeline session=open sessionLabel="Asia Late Open" adTargets=HK,ID,MY,TH,IN',
  },
  {
    id: 'flago-cron-europe-open',
    schedule_value: '30 5 * * 1-5',   // 08:30 UTC Mon–Fri
    prompt: '/social-pipeline session=open sessionLabel="Europe Open" adTargets=GB,DE,FR,NL,CH,SE,ES,ZA',
  },
  {
    id: 'flago-cron-europe-mid',
    schedule_value: '30 8 * * 1-5',   // 11:30 UTC Mon–Fri
    prompt: midPrompt('Europe Mid', 'europe', 'GB,DE,FR,NL,CH,SE,ES,ZA'),
  },
  {
    id: 'flago-cron-americas-open',
    schedule_value: '0 11 * * 1-5',   // 14:00 UTC Mon–Fri
    prompt: '/social-pipeline session=open sessionLabel="Americas Open" adTargets=US,CA,MX,BR',
  },
  {
    id: 'flago-cron-americas-mid',
    schedule_value: '30 13 * * 1-5',  // 16:30 UTC Mon–Fri
    prompt: midPrompt('Americas Mid', 'americas', 'US,CA,MX,BR'),
  },
  {
    id: 'flago-cron-saturday',
    schedule_value: '0 7 * * 6',      // 10:00 UTC Sat
    prompt: SATURDAY_PROMPT,
  },
  {
    id: 'flago-cron-sunday',
    schedule_value: '0 11 * * 0',     // 14:00 UTC Sun
    prompt: SUNDAY_PROMPT,
  },
];

// ── Common fields ─────────────────────────────────────────────────────────────

const GROUP_FOLDER = 'whatsapp_alerta-invest';
const CHAT_JID     = 'alerta-invest@pipeline';
const NOW          = new Date().toISOString();

// ── Upsert ────────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);

const upsert = db.prepare(`
  INSERT INTO scheduled_tasks
    (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
     status, context_mode, created_at)
  VALUES
    (@id, @group_folder, @chat_jid, @prompt, 'cron', @schedule_value,
     'active', 'isolated', @created_at)
  ON CONFLICT(id) DO UPDATE SET
    prompt         = excluded.prompt,
    schedule_value = excluded.schedule_value,
    status         = 'active'
`);

let inserted = 0, updated = 0;

const existing = new Set(
  db.prepare("SELECT id FROM scheduled_tasks WHERE id LIKE 'flago-%'")
    .all().map(r => r.id)
);

for (const cron of CRONS) {
  upsert.run({
    id:            cron.id,
    group_folder:  GROUP_FOLDER,
    chat_jid:      CHAT_JID,
    prompt:        cron.prompt,
    schedule_value: cron.schedule_value,
    created_at:    NOW,
  });
  if (existing.has(cron.id)) updated++; else inserted++;
}

// Remove stale flago-cron-* entries not in CRONS list
const validIds = new Set(CRONS.map(c => c.id));
const stale = [...existing].filter(id => !validIds.has(id));
if (stale.length) {
  const del = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?');
  for (const id of stale) { del.run(id); }
  console.log(`seed-crons: removed stale crons: ${stale.join(', ')}`);
}

db.close();
console.log(`seed-crons: ${inserted} inserted, ${updated} updated, ${stale.length} removed`);

// ── Seed registered groups ────────────────────────────────────────────────────

const db2 = new Database(DB_PATH);

const GROUPS = [
  {
    jid:              '558681512111@s.whatsapp.net',
    name:             'Thiago Carvalho',
    folder:           'whatsapp_main',
    trigger_pattern:  '@Andy',
    requires_trigger: 0,
    is_main:          1,
  },
  {
    jid:              '120363287717747603@g.us',
    name:             'Atendimento Dra Marina',
    folder:           'whatsapp_atendimento-dra-marina',
    trigger_pattern:  '@Andy',
    requires_trigger: 1,
    is_main:          0,
  },
  {
    jid:              '558681142212@s.whatsapp.net',
    name:             'Marina',
    folder:           'whatsapp_marina',
    trigger_pattern:  '@Andy',
    requires_trigger: 1,
    is_main:          0,
  },
];

const upsertGroup = db2.prepare(`
  INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
  VALUES (@jid, @name, @folder, @trigger_pattern, @added_at, NULL, @requires_trigger, @is_main)
`);

let gi = 0, gu = 0;
const existingGroups = new Set(
  db2.prepare('SELECT jid FROM registered_groups').all().map(r => r.jid)
);

for (const g of GROUPS) {
  upsertGroup.run({ ...g, added_at: NOW });
  if (existingGroups.has(g.jid)) gu++; else gi++;
}

db2.close();
console.log(`seed-groups: ${gi} inserted, ${gu} updated`);
