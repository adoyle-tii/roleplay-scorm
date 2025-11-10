/******************************************************************
 * main.js – ElevenLabs voice-agent SCO (calls Sales Coach Worker)
 * Adds: retry scoring via SCORM suspend_data + a Retry button.
 ******************************************************************/

import {
  scormInit,
  scormCommit,
  scormTerminate,
  scormSetScore,
  scormAddInteraction,
  getAPI,
} from './scorm.js';

import { Conversation } from '@elevenlabs/client';

/* ───────── CONFIG ───────── */
// Eleven proxy that *you* run. We’ll poll it for transcript readiness.
const PROXY_BASE = 'https://eleven-worker.salesenablement.workers.dev';

// Your Sales Coach Worker (the scorer we just built)
const ASSESS_BASE = 'https://gem-sales-coach-worker.salesenablement.workers.dev/';

// Which rubric (from KV) and which skills (namespaced “Competency|Skill”)
const RUBRIC_KEY = 'rubrics:v1';
const SKILLS = [
  'Problem Discovery|Discovering Pain Points'
];

// Pass mark (0–100)
const PASS_RAW = 70;

// Poll cadence/timeouts for transcript readiness
const POLL_MS   = 5_000;
const MAX_POLLS = 36;     // 3 minutes total

/* ───────── DOM ───────── */
const startBtn  = document.getElementById('startBtn');
const statusEl  = document.getElementById('callStatus');
const closeBtn  = document.getElementById('closeBtn');

// Ensure a Retry button exists (create if missing)
function ensureRetryButton() {
  let btn = document.getElementById('retryBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'retryBtn';
    btn.textContent = '↻ Retry scoring';
    btn.className = 'hide'; // relies on .hide{display:none} in your CSS
    // place it after Start
    startBtn.insertAdjacentElement('afterend', btn);
  }
  return btn;
}
const retryBtn = ensureRetryButton();

/* ───────── SCORM bootstrap ───────── */
scormInit();  // must be first
Object.assign(window, { scormInit, scormCommit, scormTerminate, scormSetScore });

/* ——— tiny helper ——— */
const show = (txt = '', busy = false) => {
  if (!txt) {
    statusEl.dataset.show = 'false';
    statusEl.textContent = '';
    statusEl.classList.remove('busy');
    return;
  }
  statusEl.dataset.show = 'true';
  statusEl.textContent = txt;
  statusEl.classList.toggle('busy', busy);
};

let scoreCommitted = false;

/* block unload until we save */
window.addEventListener('beforeunload', e => {
  if (!scoreCommitted) {
    e.preventDefault();
    e.returnValue = 'Please wait while we save your score…';
  }
});

const embedded = window.self !== window.top;
if (embedded) {
  closeBtn.style.display = 'none';
} else {
  closeBtn.hidden   = true;
  closeBtn.disabled = true;
  closeBtn.addEventListener('click', () => {
    if (!scoreCommitted) return;
    scormTerminate();
    setTimeout(() => window.close(), 300);
  });
}

/* ───── suspend_data helpers (store tiny JSON) ───── */
function readSuspend() {
  const { api, v } = getAPI();
  if (!api) return null;
  try {
    const raw = (v === '2004') ? api.GetValue('cmi.suspend_data')
                               : api.LMSGetValue('cmi.suspend_data');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeSuspend(obj) {
  const { api, v } = getAPI();
  if (!api) return;
  const json = JSON.stringify(obj || {});
  if (v === '2004') api.SetValue('cmi.suspend_data', json);
  else              api.LMSSetValue('cmi.suspend_data', json);
  scormCommit(); // persist immediately
}

/* show/hide retry button */
function showRetry(showIt) {
  retryBtn.classList.toggle('hide', !showIt);
  retryBtn.disabled = !showIt ? true : false;
}

/* on load: if last attempt marked pending, surface Retry */
(function bootstrapRetryUI(){
  const s = readSuspend();
  if (s?.pending && s.convId) {
    show('Previous attempt can be retried.', false);
    showRetry(true);
  } else {
    showRetry(false);
  }
})();

/* ───── poll your proxy for the **transcript** ─────
   Expectation: your proxy exposes GET /api/convai/transcript/:convId
   and returns JSON like:
     { status: "pending" | "ready" | "done", transcript?: "Agent:...\nUser:..." }
*/
async function pollTranscript(convId) {
  console.log('[TRANSCRIPT] waiting on', convId);
  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      const r = await fetch(`${PROXY_BASE}/api/convai/transcript/${encodeURIComponent(convId)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j?.transcript && j.transcript.trim().length > 0) {
        console.log('[TRANSCRIPT] received');
        return String(j.transcript);
      }
      if (j?.status === 'done') break;
    } catch (err) {
      console.warn('[TRANSCRIPT] poll retry –', err);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  return '';
}

/* ───── call the Sales Coach Worker for assessment ───── */
async function assessTranscript(transcript) {
  const qs = new URLSearchParams({
    rubric_key: RUBRIC_KEY,
    skills: SKILLS.join(','),
  });
  const url = `${ASSESS_BASE}?${qs.toString()}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcript,
      include_presentation: true
      // (No need to pass rubrics; worker loads them from KV by rubric_key)
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `Worker error ${res.status}`;
    throw new Error(msg);
  }
  return data; // { assessments:[{skill,rating,strengths,improvements,coaching_tips,...}], meta, ... }
}

/* ───── compute a 0–100 score from per-skill 1–5 ratings ───── */
function computeOverallPercent(assessments) {
  if (!Array.isArray(assessments) || assessments.length === 0) return 0;
  const avg = assessments.reduce((sum, a) => sum + (Number(a?.rating) || 0), 0) / assessments.length;
  return Math.round((avg / 5) * 100); // 1→20, 5→100
}

/* ───── text assembly for SCORM comments/feedback ───── */
function formatRationale(assessments) {
  const parts = (assessments || []).map(a => `${a.skill}: ${a.rating}/5`);
  return parts.join(' • ');
}
function formatDetailedFeedback(assessments, maxChars = 4000) {
  const blocks = [];
  for (const a of assessments || []) {
    const strengths = (a.strengths || []).slice(0, 2).map(s => `• ${s}`).join('\n') || '• —';
    const gapsArr = (a.improvements || []).slice(0, 2).map(i => {
      const tail = i?.quote ? ` — "${i.quote}"` : '';
      return `• ${i?.point || '—'}${tail}`;
    });
    const gaps = gapsArr.length ? gapsArr.join('\n') : '• —';
    const tips = (a.coaching_tips || []).slice(0, 3).map(t => `• ${t}`).join('\n') || '• —';
    blocks.push(
`[${a.skill}] Score: ${a.rating}/5
Strengths:
${strengths}
Weaknesses:
${gaps}
Coaching Tips:
${tips}`
    );
  }
  let out = blocks.join('\n\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 20) + '\n…(truncated)';
  return out;
}

/* ───── commit everything to LMS ───── */
function commitToLMS({ raw, rationale, feedback }) {
  // 1) raw + completion
  scormSetScore(raw);

  // 2) success/failure purely by score threshold
  const { api, v } = getAPI();
  if (!api) {
    console.warn('[SCORM] API not found – cannot record success/feedback');
    return;
  }

  const pass   = raw >= PASS_RAW;
  const scaled = (raw / 100).toFixed(4);

  if (v === '2004') {
    api.SetValue('cmi.score.min',         '0');
    api.SetValue('cmi.score.max',         '100');
    api.SetValue('cmi.score.scaled',      scaled);
    api.SetValue('cmi.success_status',    pass ? 'passed' : 'failed');

    // Optional: compact summary in comments_from_lms
    const idx = Number(api.GetValue('cmi.comments_from_lms._count')||0);
    api.SetValue(`cmi.comments_from_lms.${idx}.comment`,   rationale);
    api.SetValue(`cmi.comments_from_lms.${idx}.timestamp`, new Date().toISOString());
    api.SetValue(`cmi.comments_from_lms.${idx}.location`,  'sales_coach_summary');
  } else {
    api.LMSSetValue('cmi.core.score.min',        '0');
    api.LMSSetValue('cmi.core.score.max',        '100');
    api.LMSSetValue('cmi.core.score.raw',        String(raw));
    api.LMSSetValue('cmi.core.lesson_status',    pass ? 'passed' : 'failed');

    // Optional summary for 1.2
    api.LMSSetValue('cmi.comments',              rationale);
  }

  // 3) ONE interaction only: neutral result, no weighting (non-gating)
  scormAddInteraction({
    id:           'sales_coach_feedback',
    description:  'Per-skill feedback (score, strengths, weaknesses, coaching tips)',
    response:     feedback,      // big text block
    result:       'neutral'      // ensures it never gates pass/fail
  });

  // 4) finalize
  scormCommit();
  scormTerminate();
  scoreCommitted = true;
}

/* ───── Retry flow ───── */
async function retryScoring() {
  scormInit();                // re-open session
  show('Retrying scoring…', true);
  retryBtn.disabled = true;

  try {
    const s = readSuspend();
    if (!s?.convId) throw new Error('No previous attempt recorded.');
    const convId = s.convId;

    // 1) fetch transcript again
    const transcript = await pollTranscript(convId);
    if (!transcript) throw new Error('Transcript still unavailable.');

    // 2) call assessor
    const result = await assessTranscript(transcript);

    // 3) compute + commit
    const percent    = computeOverallPercent(result.assessments);
    const rationale  = formatRationale(result.assessments);
    const feedback   = formatDetailedFeedback(result.assessments);
    commitToLMS({ raw: percent, rationale, feedback });

    // 4) clear pending flag
    writeSuspend({});
    showRetry(false);
    show(`Finished ✔ Score ${percent}`);
  } catch (err) {
    console.error('[RETRY] failed:', err);
    show('Retry failed – please try again shortly.');
    retryBtn.disabled = false;  // allow another attempt
  }
}
retryBtn.addEventListener('click', retryScoring);

/* ───── Start-Call handler ───── */
export async function startAgent() {
  scormInit();          // fresh session each try
  scoreCommitted = false;

  show('Loading agent…', true);
  startBtn.disabled = true;

  const convo = await Conversation.startSession({
    agentId:      'agent_01k06t3bfjfec9ay9xbm6mxceh', // unchanged
    onConnect:    () => show('Listening…'),
    onModeChange: ({ mode }) => show(mode === 'speaking' ? 'Agent speaking…' : 'Listening…'),
    onDisconnect: async () => {
      show('Processing call…', true);

      try {
        // 1) wait for transcript
        const transcript = await pollTranscript(convo.getId());
        if (!transcript) throw new Error('No transcript available');

        // 2) send to Sales Coach Worker
        const result = await assessTranscript(transcript);

        // 3) compute score + build text
        const percent    = computeOverallPercent(result.assessments);
        const rationale  = formatRationale(result.assessments);
        const feedback   = formatDetailedFeedback(result.assessments);

        // 4) commit to LMS
        commitToLMS({ raw: percent, rationale, feedback });

        // 5) clear pending state on success
        writeSuspend({});
        showRetry(false);
        show(`Finished ✔ Score ${percent}`);
      } catch (err) {
        console.error('[FLOW] failed:', err);

        // record pending so learner can retry later
        writeSuspend({
          pending:   true,
          convId:    convo.getId(),
          rubricKey: RUBRIC_KEY,
          skills:    SKILLS,
          ts:        Date.now()
        });
        showRetry(true);
        show('Finished – score pending (you can retry).');
      }

      if (!embedded) {
        closeBtn.hidden   = false;
        closeBtn.disabled = false;
      }
      startBtn.disabled = false;
    }
  });

  // Immediately store basics so we have an id even if the tab closes before onDisconnect runs.
  writeSuspend({
    pending:   true,
    convId:    convo.getId(),
    rubricKey: RUBRIC_KEY,
    skills:    SKILLS,
    ts:        Date.now()
  });

  console.log('[CALL] conversation', convo.getId());
}

window.startAgent = startAgent;
