// --- worker.js ---

// ===================================================================================
// >>>>>>>>>>>>>>>>>>>> ALL SHARED BUSINESS LOGIC & HELPER FUNCTIONS <<<<<<<<<<<<<<<<<
// ===================================================================================

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => { if (v === undefined || v === null) return d; const s = String(v).toLowerCase().trim(); return s === "true" || s === "1" || s === "yes"; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { retries = 2, baseMs = 500, factor = 1.8, jitter = true } = {}) {
  let attempt = 0, delay = baseMs, lastErr;
  while (attempt <= retries) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!/timeout|timed out|429|5\d\d|unavailable|quota|exhausted/i.test(msg) || attempt === retries) break;
      const wait = jitter ? Math.round(delay * (0.7 + Math.random() * 0.6)) : delay;
      await sleep(wait);
      delay = Math.min(delay * factor, 8000);
      attempt++;
    }
  }
  throw lastErr;
}

async function chatOpenRouter(env, payload, { hint = "openrouter" } = {}) {
  if (!env.OPENROUTER_KEY) throw new Error(`${hint} missing OPENROUTER_KEY`);
  const base = (env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/,"");
  const timeoutMs = num(env.OPENROUTER_TIMEOUT_MS, 300000);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`API call timed out after ${timeoutMs}ms`)), timeoutMs);
  let res;
  try {
      res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.OPENROUTER_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ac.signal,
      });
  } catch (e) {
      clearTimeout(timer);
      throw e;
  } finally {
      clearTimeout(timer);
  }

  if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${hint} ${res.status}: ${errText.slice(0, 400)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content ?? "";
  return { content, json };
}

function stable(obj) {
  const seen = new WeakSet();
  const sorter = (x) => {
    if (x && typeof x === "object") {
      if (seen.has(x)) return null; seen.add(x);
      if (Array.isArray(x)) return x.map(sorter);
      return Object.keys(x).sort().reduce((o, k) => ((o[k] = sorter(x[k])), o), {});
    }
    return x;
  };
  return JSON.stringify(sorter(obj));
}

function safeParseJSON(s) {
  if (!s) return null;
  try {
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start === -1 || end === -1 || end < start) {
          throw new Error("No valid JSON object found in the string.");
      }
      const jsonString = s.substring(start, end + 1);
      return JSON.parse(jsonString);
  } catch (e) {
      console.error("Failed to parse JSON:", e);
      return null;
  }
}

async function sha256Hex(s) {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeTranscript(s) {
  if (!s) return "";
  return String(s).replace(/\t/g, " ").replace(/[ \u00A0]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function __normalizeTranscriptSimple(s) {
  if (!s) return "";
  return String(s).replace(/\t/g, " ").replace(/[ \u00A0]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function simpleSkillKeyHash({ cacheVersion, transcript, sellerId, skillName }) {
    const input = { v: String(cacheVersion || "1"), sellerId: String(sellerId || ""), skillName: String(skillName || ""), transcript: normalizeTranscript(transcript || "") };
    return await sha256Hex(stable(input));
}

async function kvGetJSON(ns, key) {
  if (!ns) return null;
  const s = await ns.get(key);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

async function kvPutJSON(ns, key, obj, ttlSecs, cacheVersion) {
  if (!ns) return;
  await ns.put(key, JSON.stringify(obj), { expirationTtl: ttlSecs, metadata: { createdAt: Date.now(), version: cacheVersion } });
}

function normKey(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function buildSkillMap(rubricsObj) {
  const map = new Map();
  for (const comp in (rubricsObj || {})) {
    const skillsObj = rubricsObj[comp]?.skills || {};
    for (const skillName in skillsObj) {
      map.set(normKey(skillName), { skillName, competency: comp, rubricData: skillsObj[skillName] });
    }
  }
  return map;
}

function resolveSkill(rubricsObj, requestedName) {
  const m = buildSkillMap(rubricsObj);
  return m.get(normKey(requestedName)) || null;
}

const OR_SYSTEM_COACH = `
You are a practical, expert sales coach. Your task is to provide concise, actionable feedback based on a provided analysis. You MUST follow the JSON schema below perfectly. The user's prompt will provide specific instructions on what kind of content to generate for each field based on the seller's score.
{
  "strengths": ["List of strengths exhibited."],
  "improvements": [{"point": "A specific point for improvement, refinement, or a next-level challenge.", "example": {"instead_of": "A quote or summary of what the seller did.", "try_this": "A suggestion for what the seller could have done instead."}}],
  "coaching_tips": ["A list of actionable coaching tips."]
}`;

// ===================================================================================
// >>>>>>>>>>>>>>>>>>>>>>>>>>>> PROMPT BUILDERS & CORE LOGIC <<<<<<<<<<<<<<<<<<<<<<<<<
// ===================================================================================

function buildAnalysisPrompt(skillName, rubricData, transcript, sellerName) {
  const sortedRubric = stable(rubricData);
  return `You are an OBJECTIVE AI Analyst. Your only function is to grade a sales transcript against a provided rubric for a seller named "${sellerName}". You must follow a strict reasoning process and be hyper-critical in your analysis. Your default answer for 'met' should be 'false' unless there is overwhelming, direct evidence to the contrary.

  **TRANSCRIPT:**
  ---
  ${transcript}
  ---
  
  **SKILL RUBRIC:**
  ---
  ${sortedRubric}
  ---
  
  **TASK:**
  For EACH characteristic in EACH level of the rubric, you must perform the following 10-step chain of thought:
  
  1.  **Understand the Ask:** Paraphrase the core seller behavior described in the characteristic.
  2.  **Check for Frequency Adverb:** Does the characteristic contain a frequency adverb (e.g., "Consistently", "Frequently", "Attempts", "Occasionally", "Rarely", "Not", "Does not")?
  
      * If **YES**, proceed to step 3 (Frequency Analysis).
      * If **NO** (e.g., a simple behavior like "Provides a multi-point summary"), skip to step 5 (Simple Scan).
  
  3.  **Frequency Analysis (Denominator):** Scan the *entire* transcript to find ALL logical **Opportunities** where the seller *could have* applied this behavior. (e.g., If the characteristic is "Uses labeling," an Opportunity is any time the client states an emotion or pain point).
  4.  **Frequency Analysis (Numerator & Quality):** For each Opportunity, check if the seller **Acted** on it. Calculate the ratio of (Actions / Opportunities) and assess the average **Quality** (e.g., 'high-quality/accurate' vs. 'low-quality/inaccurate').
      * **Apply Frequency Definitions:**
          * **Consistently / Always:** Met if ratio is >80% AND quality is high.
          * **Frequently / Typically:** Met if ratio is 50-79% AND quality is good.
          * **Attempts / Inconsistently / Occasionally:** Met if ratio is 20-49% OR if quality is low/inaccurate (e.g., they *tried* but *failed*).
          * **Rarely / Limited:** Met if ratio is <20%.
          * **Not demonstrated / Does not:** Met if ratio is 0% OR if the seller demonstrated the *opposite* behavior (e.g., "Consistently interrupts").
      * *Skip to Step 7.*
  
  5.  **Simple Scan (if NO Frequency Adverb):** Find ALL quotes from "${sellerName}" that are *directly* relevant to the characteristic.
  6.  **Critique & Filter (for Simple Scan):** Scrutinize the quotes. Do they *directly* and *unambiguously* demonstrate the skill *at least once*? Discard weak quotes.
  7.  **Synthesize & Justify:** Formulate your 'reason' based on your findings.
      * *For Frequency Analysis:* State the ratio (e.g., "Seller used labeling on 2/8 opportunities (25%), which meets the 'Attempts' threshold but not the 'Frequently' threshold.").
      * *For Simple Scan:* State the conclusion (e.g., "Seller provided a clear multi-point summary at 04:15.").
  8.  **Initial Determination:** Tentatively set 'met' to 'true' or 'false' based on your justification.
  9.  **Sanity Check:** Before finalizing a 'false' determination, ask: 'Is the reason for failure because the seller's performance *exceeded* the criteria?'
      * If YES (e.g., the check was for "Attempts labeling" but the seller "Consistently" did it), you MUST change the determination to 'met: true' and briefly explain this in your 'reason' (e.g., "Met: Seller's performance *exceeded* this standard, demonstrating 'Consistent' use...").
      * If NO, keep the 'false' determination.
  10. **Finalize:** Assemble the final JSON object for the characteristic.
  
  After completing this process for every single characteristic, assemble the final JSON object.
  
  **CRITICAL RULE 1:** The example below is for structure only. You MUST NOT use the content from the example in your response. Your analysis must be based entirely on the provided transcript and rubric.
  **CRITICAL RULE 2:** If any of your 'reason' or 'evidence' strings contain double quotes ("), you MUST escape them with a backslash (\\"). For example, "He said \\"great.\\""
  **CRITICAL RULE 3 (Polarity):**
  - For "positive" polarity, 'met: true' means the seller's behavior met or exceeded the standard.
  - For "negative" or "limitation" polarity, 'met: true' means the seller successfully *avoided* the negative behavior.
  
  **JSON OUTPUT EXAMPLE:**
  Your final output MUST follow this exact structure.
  \`\`\`json
  {
  "level_checks": [
    {
      "level": 1,
      "name": "Novice",
      "checks": [
        {
          "characteristic": "The first characteristic from the rubric for Level 1.",
          "polarity": "limitation",
          "met": false,
          "evidence": ["An example quote if found, otherwise empty array."],
          "reason": "Your detailed justification based on the chain of thought."
        }
      ]
    }
  ]
  }
  \`\`\`
`;
}

function buildSimplifiedCoachingPrompt(skillName, rating, rubricData, transcript) {
  const nextLevelNumber = rating + 1;
  const nextLevel = (rubricData.levels || []).find(l => l.level === nextLevelNumber);
  const improvementFocus = nextLevel ? `Focus on the characteristics from Level ${nextLevelNumber} ('${nextLevel.name}') as the primary areas for improvement.` : "Focus on general best practices.";
  return `You are a practical, expert sales coach. Your task is to provide concise, actionable feedback based on the provided transcript, the seller's assessed skill level, and the skill rubric. You MUST return a single, valid JSON object matching the schema in the system prompt and nothing else.
  
  **BUSINESS CONTEXT (Follow these rules):**
  - The company is "Turnitin".
  - The company operates exclusively in the EdTech / Education sector.
  - All coaching and suggestions must be relevant to selling technology solutions to educational institutions (universities, colleges, schools etc.).
  - DO NOT suggest exploring other industries or business sectors.
  
  **CONTEXT:**
- **Skill:** "${skillName}"
- **Assessed Level:** The seller has demonstrated proficiency at **Level ${rating}**.
**YOUR TASK:**
1.  **Analyze Transcript:** Read the full transcript.
2.  **Generate 'strengths'**: Based on **Level ${rating}** characteristics, write 2-4 strengths.
3.  **Generate 'improvements'**: Find 1-3 moments where the seller missed a chance to perform at the next level. ${improvementFocus}
4.  **Generate 'coaching_tips'**: Write 3-6 actionable tips related to the improvements.
**FULL SKILL RUBRIC:** ${stable(rubricData)}
**FULL TRANSCRIPT:**
---
${transcript}
---`;
}

function computeHighestDemonstrated(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return 1;

  const didPassLevel = (lvl) => {
      if (!lvl || !Array.isArray(lvl.checks) || lvl.checks.length === 0) {
          return false;
      }
      return lvl.checks.every(c => c.met === true);
  };

  const sorted = [...levels].sort((a, b) => (a.level || 0) - (b.level || 0));
  let highest = 0;

  for (const lvl of sorted) {
      if (didPassLevel(lvl)) {
          highest = Math.max(highest, lvl.level || 0);
      }
  }
  return highest > 0 ? highest : 1;
}

function buildCoachingPrompt(skillName, rating, levelChecks) {
  let improvementTitle = "Areas for Improvement";
  let improvementInstruction = `Based on unmet characteristics from the next level up, find 2-4 moments where the seller missed a chance to perform at a higher level.`;
  let tipInstruction = `Write 3-5 actionable tips related to the improvements.`;

  if (rating >= 5) {
    improvementTitle = "Next-Level Opportunities";
    improvementInstruction = `Since the seller has demonstrated mastery, identify 2-3 advanced, strategic opportunities for them to deepen their expertise...`;
    tipInstruction = `Provide 2-3 expert-level tips that would help a master practitioner maintain their edge or teach this skill to others.`;
  } else if (rating === 4) {
    improvementTitle = "Areas for Refinement to Reach Mastery";
    improvementInstruction = `The seller is proficient. Identify 2-4 specific moments where they could have elevated their performance from 'proficient' to 'mastery'...`;
    tipInstruction = `Provide 2-4 actionable tips that would help a proficient seller bridge the gap to mastery.`;
  }

  const coachUserPrompt = `You are an expert AI Sales Coach. The analysis for "${skillName}" has a final rating of ${rating}/5. Use ONLY this analysis: ${stable({ level_checks: levelChecks })}.
  
  **BUSINESS CONTEXT (Follow these rules):**
  - The company is "Turnitin".
  - The company operates exclusively in the EdTech / Education sector.
  - All coaching and suggestions must be relevant to selling technology solutions to educational institutions (universities, colleges, schools etc.).
  - DO NOT suggest exploring other industries or business sectors.
  
  YOUR TASK: Return ONLY a valid JSON object.
  - **Strengths**: Write 2-4 strengths based on the characteristics of the highest achieved level (${rating}/5).
  - **${improvementTitle}**: ${improvementInstruction}
  - **Coaching Tips**: ${tipInstruction}`;

  return { coachUserPrompt, improvementTitle };
}

// ===================================================================================
// >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> ROUTE HANDLERS <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
// ===================================================================================

async function handleQualifySkills(request, env) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  const body = await request.json().catch(() => ({}));
  const { transcript, allSkills, sellerId } = body;
  const CACHE_VERSION = String(env.CACHE_VERSION || "1");
  const KV_TTL_SECS = num(env.KV_TTL_SECS, 60 * 60 * 24 * 7);

  if (!transcript || !Array.isArray(allSkills) || !sellerId) {
    return new Response(JSON.stringify({ error: "Missing 'transcript', 'allSkills', or 'sellerId'." }), { status: 400, headers });
  }

  const normTranscript = normalizeTranscript(transcript);
  let rubricContext = "";
  try {
    const rubricsText = await env.RUBRICS.get(env.DEFAULT_RUBRIC_SET || "rubrics:v1", "text");
    if (rubricsText) {
      const rubricsObj = JSON.parse(rubricsText);
      const hints = Object.entries(rubricsObj || {}).map(([comp, v]) => {
        const skills = Object.keys((v && v.skills) || {}).slice(0, 12);
        return { competency: comp, skills };
      });
      rubricContext = JSON.stringify(hints, null, 2);
    }
  } catch (_) { /* ignore */ }

  const cacheKeyInput = stable({ v: CACHE_VERSION, transcript: normTranscript, sellerId, allSkills });
  const cacheKeyHash = await sha256Hex(cacheKeyInput);
  const kvKey = `v${CACHE_VERSION}:qualify:${cacheKeyHash}`;
  if (env.ASSESS_CACHE) {
    const cached = await kvGetJSON(env.ASSESS_CACHE, kvKey);
    if (cached) return new Response(JSON.stringify(cached), { headers });
  }

  const qualificationPrompt = `You are an expert sales coach AI embedded in a sales enablement workflow. Select which skills from the provided catalog the SELLER demonstrated with enough substance to be coachable **for this call**.



**Seller:** ${sellerId}



**Transcript:**

---

${normTranscript}

---



**Skill Catalog (use these exact strings verbatim in output; map by meaning with fuzzy/synonym matching):**

${JSON.stringify(allSkills, null, 2)}



${

rubricContext

? `**Competency Hints (for context only, not exhaustive):**

${rubricContext}`

: ""

}



**GUIDANCE (do not include this section in your output):**

1) **Detect Call Context/Stage (non-exhaustive):** Infer the meeting type from behavior and goals (e.g., intro discovery/qualification, multi-stakeholder discovery, CSM check-in, technical deep-dive, demo, commercial/negotiation, renewal, expansion, exec alignment, handoff, implementation planning, QBR/EBR, partner, procurement/legal, etc.). These are examples, not a closed list.



2) **Rubric Awareness:** Decide if a skill is assessable like a rubric grader: was there enough signal for a fair evaluation **today**? Prefer skills that logically fit the detected stage.

- Discovery/Qualification examples to prioritise: rapport/agenda, stakeholder/authority mapping, current process & tooling, needs/pain points, desired outcomes/success criteria, technical fit/constraints, compliance/language/regions, volume/scale, timeline/urgency, budget/financial fit, decision process/procurement, competitive landscape, closing for next step.



3) **Evidence Threshold (inclusive but meaningful):** Qualify a skill if **either** a) it appears in one **substantive episode** (a short sequence of seller turns that explores/summarizes/advances that skill), **or** b) it appears in **two separate moments** in the call.

Stage exceptions: a single clear action can qualify **Agenda/Framing**, **Next Step/Close**, or **Logistics/Time-zone coordination**.

Do **not** include skills that are only one-off superficial mentions.



4) **Map by Meaning, Not Keywords:** e.g., “Who else would be involved?” → Buying Centre/Decision Process; “When would you want to move ahead?” → Timeline/Urgency; “Do you have a budget set aside?” → Budget/Financial Fit; “We use Moodle; need exam security; AI policy in English” → Current Process/Tooling, Technical Fit, Compliance/Language, Needs/Desired Outcomes.



5) **Adaptive Inclusivity:** - If you find **fewer than 6** qualifying skills, slightly relax to accept strong single episodes (avoid under-selection on early-stage calls).

- If you find **more than 12**, keep only the strongest **8–12** that are most stage-appropriate.



6) **Catalog Integrity:** Output **only** strings that appear in the Skill Catalog. No paraphrases or new names. No duplicates.



**OUTPUT (strict):** Return ONLY a valid JSON object with a single key **"qualifiedSkills"** whose value is an array of strings (ideally 8–12) from the catalog. No other keys or text.



**RETURN ONLY:**

{"qualifiedSkills":[/* exact catalog strings here */]}

`;



  const qualificationResp = await chatOpenRouter(env, {
    model: env.JUDGE_MODEL,
    temperature: 0.0,
    max_tokens: 8192,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are an AI analyst that only responds with JSON." },
      { role: "user", content: qualificationPrompt }
    ],
  }, { hint: "qualify" });

  const parsed = safeParseJSON(qualificationResp.content);
  const qualifiedSkills = parsed?.qualifiedSkills || [];
  if (!parsed) {
      console.error("Failed to parse qualification response. Raw output:", qualificationResp.content.slice(0, 200));
  }

  // *** Check cache status for each qualified skill ***
  const skillsWithCacheStatus = await Promise.all(
    qualifiedSkills.map(async (skillName) => {
        const skillKeyHash = await simpleSkillKeyHash({ cacheVersion: CACHE_VERSION, transcript: normTranscript, sellerId, skillName });
        const kvKey = `v${CACHE_VERSION}:assessment:${skillKeyHash}`;
        const cached = env.ASSESS_CACHE ? await kvGetJSON(env.ASSESS_CACHE, kvKey) : null;
        return { skill: skillName, cached: !!cached };
    })
);

  const responsePayload = { qualifiedSkills: skillsWithCacheStatus, sellerIdentity: sellerId };
  if (env.ASSESS_CACHE) {
    await kvPutJSON(env.ASSESS_CACHE, kvKey, responsePayload, KV_TTL_SECS, CACHE_VERSION);
  }
  return new Response(JSON.stringify(responsePayload), { headers });
}

async function handleJudge(request, env) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    const body = await request.json().catch(() => ({}));
    const { transcript, skill, sellerId } = body;
    const CACHE_VERSION = String(env.CACHE_VERSION || "1");

    if (!transcript || !skill || !sellerId) {
        return new Response(JSON.stringify({ error: "Missing 'transcript', 'skill', or 'sellerId'." }), { status: 400, headers });
    }

    const normTranscript = normalizeTranscript(transcript);
    const skillKeyHash = await simpleSkillKeyHash({ cacheVersion: CACHE_VERSION, transcript: normTranscript, sellerId, skillName: skill });
    const kvKey = `v${CACHE_VERSION}:assessment:${skillKeyHash}`;

    if (env.ASSESS_CACHE) {
        const cached = await kvGetJSON(env.ASSESS_CACHE, kvKey);
        if (cached) {
            console.log(`CACHE HIT for skill: ${skill}`);
            return new Response(JSON.stringify({ ...cached, meta: { kv_hit: true } }), { headers });
        }
    }
    console.log(`CACHE MISS for skill: ${skill}`);

    const rubricsText = await env.RUBRICS.get(env.DEFAULT_RUBRIC_SET || "rubrics:v1", "text");
    if (!rubricsText) throw new Error("Could not load rubrics from KV.");
    const allRubrics = JSON.parse(rubricsText);

    const resolvedSkill = resolveSkill(allRubrics, skill);
    if (!resolvedSkill) throw new Error(`Could not resolve skill: ${skill}`);

    const judgeUserPrompt = buildAnalysisPrompt(resolvedSkill.skillName, resolvedSkill.rubricData, normTranscript, sellerId);

    const judgeResp = await chatOpenRouter(env, {
        model: env.JUDGE_MODEL,
        temperature: 0.0,
        max_tokens: 12000,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: "You are an objective rubric grader. Your entire response MUST be a single, valid JSON object that conforms to the user's example. Follow all rules precisely." }, { role: "user", content: judgeUserPrompt }],
    }, { hint: "judge" });

    const parsedJudge = safeParseJSON(judgeResp.content);
    if (!parsedJudge) {
        throw new Error(`Judge returned invalid or unparsable JSON for ${resolvedSkill.skillName}.`);
    }

    const levelChecks = parsedJudge.level_checks || [];
    const rating = computeHighestDemonstrated(levelChecks);

    const result = {
        skillKeyHash,
        skillName: resolvedSkill.skillName,
        rating,
        levelChecks,
        rawJudge: parsedJudge,
        meta: { kv_hit: false } // Ensures meta object is always present
    };
    return new Response(JSON.stringify(result), { headers });
}

async function handleGenerateCoaching(request, env) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    const body = await request.json().catch(() => ({}));
    const { skillName, rating, levelChecks, skillKeyHash } = body;
    const CACHE_VERSION = String(env.CACHE_VERSION || "1");
    const KV_TTL_SECS = num(env.KV_TTL_SECS, 60 * 60 * 24 * 14);

    if (!skillName || typeof rating !== 'number' || !levelChecks || !skillKeyHash) {
        return new Response(JSON.stringify({ error: "Missing required data for coaching." }), { status: 400, headers });
    }

    const { coachUserPrompt, improvementTitle } = buildCoachingPrompt(skillName, rating, levelChecks);

    const coachResp = await chatOpenRouter(env, {
        model: env.COACH_MODEL || "openai/gpt-4o-mini",
        temperature: 0.2, max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: OR_SYSTEM_COACH }, { role: "user", content: coachUserPrompt }]
    }, { hint: "coach" });

    let coachingResult = {};
    try { coachingResult = safeParseJSON(coachResp.content) || {}; }
    catch (e) { console.error(`Coach parse failed for ${skillName}: ${e.message}`); }

    const finalAssessment = {
        skill: skillName,
        rating,
        ...coachingResult,
        improvement_title: improvementTitle,
        level_checks: levelChecks
    };

    if (env.ASSESS_CACHE) {
        const kvKey = `v${CACHE_VERSION}:assessment:${skillKeyHash}`;
        await kvPutJSON(env.ASSESS_CACHE, kvKey, finalAssessment, KV_TTL_SECS, CACHE_VERSION);
        console.log(`CACHE SET for skill: ${skillName}`);
    }

    return new Response(JSON.stringify(finalAssessment), { headers });
}

async function handleCoachingFeedback(request, env) {
  const t0 = Date.now();
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  const body = await request.json().catch(() => ({}));
  const { transcript, skills } = body;
  
  if (!transcript || !Array.isArray(skills) || skills.length === 0) {
      return new Response(JSON.stringify({ error: "Missing 'transcript' or 'skills' array." }), { status: 400, headers });
  }

  const normTranscript = __normalizeTranscriptSimple(transcript);

  const cacheKeyInput = stable({ v: String(env.CACHE_VERSION || "1"), transcript: normTranscript, skills });
  const cacheKeyHash = await sha256Hex(cacheKeyInput);
  const kvKey = `v${String(env.CACHE_VERSION || "1")}:coach-roleplay:${cacheKeyHash}`;
  if (env.ASSESS_CACHE) {
      const cached = await kvGetJSON(env.ASSESS_CACHE, kvKey);
      if (cached) {
          cached.meta = { ...(cached.meta || {}), kv_hit: true, duration_ms: Date.now() - t0 };
          return new Response(JSON.stringify(cached), { headers });
      }
  }

  const rubricsText = await env.RUBRICS.get(env.DEFAULT_RUBRIC_SET || "rubrics:v1", "text");
  if (!rubricsText) throw new Error("Could not load rubrics from KV.");
  const allRubrics = JSON.parse(rubricsText);
  const assessments = [];

  for (const skillInfo of skills) {
      const { skill: skillName, score: rating } = skillInfo;
      const resolved = resolveSkill(allRubrics, skillName);
      if (!resolved || !resolved.rubricData) continue;

      const coachUserPrompt = buildSimplifiedCoachingPrompt(skillName, rating, resolved.rubricData, normTranscript);
      const coachResp = await chatOpenRouter(env, {
          model: env.COACH_MODEL || "openai/gpt-4o-mini",
          temperature: 0.2, max_tokens: 2048, response_format: { type: "json_object" },
          messages: [{ role: "system", content: OR_SYSTEM_COACH }, { role: "user", content: coachUserPrompt }]
      }, { hint: "coach" });

      let coachingResult = {};
      try { coachingResult = safeParseJSON(coachResp.content) || {}; }
      catch (e) { console.error(`Coach parse failed for ${skillName}: ${e.message}`); }

      assessments.push({ skill: skillName, rating, ...coachingResult });
  }

  const responsePayload = {
      assessments,
      meta: { duration_ms: Date.now() - t0, run_id: crypto.randomUUID(), kv_hit: false }
  };

  if (env.ASSESS_CACHE) {
      await kvPutJSON(env.ASSESS_CACHE, kvKey, responsePayload, num(env.KV_TTL_SECS, 60 * 60 * 24 * 7), String(env.CACHE_VERSION || "1"));
  }

  return new Response(JSON.stringify(responsePayload), { headers });
}


// --- Main Export & Router ---
export default {
  async fetch(request, env, ctx) {
    const allowOrigin = env.ALLOW_ORIGIN || "*";
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Origin": allowOrigin, "Vary": "Origin", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400" },
      });
    }

    const url = new URL(request.url);
    let response;
    try {
        if (request.method === "POST" && url.pathname === "/qualify-skills") {
            response = await handleQualifySkills(request, env);
        } else if (request.method === "POST" && url.pathname === "/judge") {
            response = await handleJudge(request, env);
        } else if (request.method === "POST" && url.pathname === "/coach") {
            response = await handleGenerateCoaching(request, env);
        } else if (request.method === "POST" && url.pathname === "/coach-roleplay") {
            response = await handleCoachingFeedback(request, env);
        } else if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
            response = new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
        } else {
            response = new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
        }
    } catch (error) {
        console.error("Worker Error:", error);
        response = new Response(JSON.stringify({ error: error.message || "An internal error occurred." }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", allowOrigin);
    newHeaders.set("Vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
  },
};