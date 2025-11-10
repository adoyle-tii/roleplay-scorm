/* ------------------------------------------------------------------
   Lightweight SCORM helper (SCORM 1.2 + 2004 4th‑Ed)
   ------------------------------------------------------------------ */

export function getAPI () {
  const walk = (start) => {
    let win = start, depth = 0;
    while (win && depth < 7) {
      if (win.API_1484_11) return { api: win.API_1484_11, v: '2004' };
      if (win.API)         return { api: win.API,        v: '1.2'  };
      try { win = win.parent; } catch { break; }
      depth++;
    }
    return { api: null, v: null };
  };

  let res = walk(window);
  if (res.api) return res;
  if (window.opener) res = walk(window.opener);
  return res;
}

/* ── generic setter ───────────────────────────────────────────── */
export function scormSetValue (element, value) {
  const { api, v } = getAPI();
  if (!api) return;

  if (v === '2004')      api.SetValue(element, String(value));
  else if (v === '1.2')  api.LMSSetValue(element, String(value));
}

/* ── public helpers ───────────────────────────────────────────── */
export function scormInit () {
  const { api } = getAPI();
  if (api?.Initialize)    api.Initialize('');
  if (api?.LMSInitialize) api.LMSInitialize('');
}

export function scormCommit () {
  const { api } = getAPI();
  if (api?.Commit)    api.Commit('');
  if (api?.LMSCommit) api.LMSCommit('');
}

export function scormTerminate () {
  const { api } = getAPI();
  if (api?.Terminate) api.Terminate('');
  if (api?.LMSFinish) api.LMSFinish('');
}

export function scormSetScore (raw, scaled = null) {
  const { api, v } = getAPI();
  if (!api) return;

  /* raw is always written */
  if (v === '2004')  api.SetValue('cmi.score.raw', String(raw));
  else               api.LMSSetValue('cmi.core.score.raw', String(raw));

  /* in SCORM 2004 we can also send scaled/min/max for nicer dashboards */
  if (v === '2004' && scaled != null) {
    api.SetValue('cmi.score.scaled', scaled.toFixed(4));
    api.SetValue('cmi.score.min',    '0');
    api.SetValue('cmi.score.max',    '100');
  }

  /* mark completion – let calling code decide success/failure */
  if (v === '2004')  api.SetValue('cmi.completion_status', 'completed');
  else               api.LMSSetValue('cmi.core.lesson_status', 'completed');
}

export function scormAddInteraction({ id, description='', response, result, weighting }) {
  const { api, v } = getAPI();
  if (!api) return;

  const countName = v === '2004'
      ? 'cmi.interactions._count'
      : 'cmi.interactions._count';            // same path in 1.2

  const idx = Number(api.GetValue(countName) || 0);

  const set = (p, val) =>
    v === '2004'
      ? api.SetValue(`cmi.interactions.${idx}.${p}`, val)
      : api.LMSSetValue(`cmi.interactions.${idx}.${p}`, val);

  set('id', id);
  set('type', 'fill-in');
  set('learner_response', response);
  set('result', result);                  // correct / incorrect / neutral
  if (description) set('description', description);
  if (weighting !== undefined) set('weighting', String(weighting));
}
