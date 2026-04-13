// Marketing Engine — Autonomous daily marketing meeting with 3 AI personas
// Dan (Chief of Staff) + Gary (Distribution, Vee lens) + Alex (Value, Hormozi lens)
// Produces daily briefings with content recommendations, personal education, newsletter ideas

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const BRIEFINGS_DIR = path.join(DATA_DIR, "briefings");
const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || "";

// Ensure briefings directory exists
if (!fs.existsSync(BRIEFINGS_DIR)) fs.mkdirSync(BRIEFINGS_DIR, { recursive: true });

// Import voice rules and content framework from existing engine
const { VOICE_RULES, CONTENT_FRAMEWORK, loadContentFeedback } = require("./content-engine");
const marketData = require("./market-data");

// ─── Briefing CRUD ─────────────────────────────────────────────────

function briefingPath(date) {
  return path.join(BRIEFINGS_DIR, `${date}.json`);
}

function loadBriefing(date) {
  try { return JSON.parse(fs.readFileSync(briefingPath(date), "utf8")); }
  catch { return null; }
}

function saveBriefing(briefing) {
  fs.writeFileSync(briefingPath(briefing.date), JSON.stringify(briefing, null, 2));
}

function listBriefings(limit = 14) {
  try {
    const files = fs.readdirSync(BRIEFINGS_DIR)
      .filter(f => f.endsWith(".json"))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit);
    return files.map(f => {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(BRIEFINGS_DIR, f), "utf8"));
        return { date: b.date, generatedAt: b.generatedAt, summary: b.briefingSummary, recommendationCount: (b.contentRecommendations || []).length };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getLatestBriefing() {
  const list = listBriefings(1);
  if (list.length === 0) return null;
  return loadBriefing(list[0].date);
}

// ─── The Daily Marketing Meeting ───────────────────────────────────

async function runDailyMeeting(options = {}) {
  const key = ANTHROPIC_API_KEY();
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  console.log("[marketing-engine] Starting daily marketing meeting...");

  // Gather all intelligence
  const intelligence = await marketData.gatherMarketIntelligence();

  // Determine today's content framework theme
  const todayTheme = CONTENT_FRAMEWORK[intelligence.dayOfWeek] || null;

  // Build the meeting prompt
  const prompt = buildMeetingPrompt(intelligence, todayTheme, options);

  // Call Claude
  const result = await callClaude(prompt, { maxTokens: 6000 });

  // Parse the briefing
  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in meeting response");

  const briefingData = JSON.parse(jsonMatch[0]);

  // Enrich with metadata
  const briefing = {
    date: intelligence.date,
    generatedAt: new Date().toISOString(),
    dayOfWeek: intelligence.dayOfWeek,
    todayTheme: todayTheme ? todayTheme.theme : null,
    ...briefingData,
    // Add IDs to recommendations
    contentRecommendations: (briefingData.contentRecommendations || []).map((r, i) => ({
      id: `rec-${Date.now().toString(36)}${i}`,
      status: "pending", // pending | approved | rejected | published
      ...r,
    })),
    // Source data summary
    sourceData: {
      newsCount: intelligence.industryNews.length,
      hasRates: !!intelligence.rates?.bps_change,
      hasPipeline: intelligence.pipelineContext !== "No pipeline data available.",
      hasSearchTrends: !!intelligence.searchTrends,
    },
  };

  saveBriefing(briefing);
  console.log(`[marketing-engine] Briefing generated: ${(briefing.contentRecommendations || []).length} recommendations`);

  return briefing;
}

function buildMeetingPrompt(intelligence, todayTheme, options) {
  const feedbackContext = loadContentFeedback().slice(-5).map(f => `- "${f.feedback}"`).join("\n");

  return `You are running the daily marketing meeting for Anchor Mortgage Group. Today is ${intelligence.date} (${intelligence.dayOfWeek}).

THREE PERSONAS participate in this meeting. Each has a distinct role:

═══════════════════════════════════════════════════════════
PERSONA 1: DAN — Chief of Staff
═══════════════════════════════════════════════════════════
Role: Data synthesizer and coordinator. Pull out what matters from the noise.
- Summarize overnight market movements (rates, MBS, Treasury)
- Flag the 2-3 industry news items worth reacting to
- Note pipeline context (upcoming closes, VA deals, complex cases)
- Check if today's content framework theme aligns with anything timely
- Produce John's personal education briefing: what he needs to KNOW today
- Identify anything John should personally read (with links)
- Flag newsletter-worthy content for borrower monthly and agent biweekly

═══════════════════════════════════════════════════════════
PERSONA 2: GARY — Distribution Strategist (Gary Vee lens)
═══════════════════════════════════════════════════════════
Role: Platform strategy, format decisions, distribution optimization.
- Every piece of content should be repurposed across multiple platforms
- Determine format per platform:
  * Facebook: short story/truth posts (borrower audience)
  * X/Twitter: hot takes, one-liners, threads (industry + agents)
  * LinkedIn: professional insight, case studies, partnership value (agent recruitment)
  * Substack: long-form Bus Stories, deep-dive education (subscribers)
  * YouTube: flag video-worthy topics for weekly market update
  * Blog/website: SEO-optimized educational articles
- Set optimal posting times per platform
- Flag visual/graphic opportunities (only when the visual adds something text can't)
- Think about ATTENTION — what's trending, what will stop the scroll
- Volume matters but only if every piece provides value

═══════════════════════════════════════════════════════════
PERSONA 3: ALEX — Value Strategist (Alex Hormozi lens)
═══════════════════════════════════════════════════════════
Role: Quality filter, education focus, trust-building.
- Kill any content that doesn't teach or build trust
- Every post must pass the "would I save this?" test
- Prioritize education: VA loans, manual underwriting, self-employed borrowers
- Flag Substack-worthy deep dives
- Ensure DUAL AUDIENCE coverage:
  * BORROWERS: education, trust, "this guy gets it"
  * AGENTS: proof of close, reliability, partnership value, "why work with a broker"
- Newsletter filter: what provides enough value to send to someone's inbox?
- Study recommendations for John personally

═══════════════════════════════════════════════════════════
BRAND & VOICE RULES (ALL content must follow these):
═══════════════════════════════════════════════════════════
${VOICE_RULES}

═══════════════════════════════════════════════════════════
TODAY'S CONTENT FRAMEWORK:
═══════════════════════════════════════════════════════════
${todayTheme ? `Today is ${intelligence.dayOfWeek}: "${todayTheme.theme}" — ${todayTheme.description}\nTone: ${todayTheme.tone}` : "Weekend — no scheduled theme. Focus on evergreen or timely content only."}

═══════════════════════════════════════════════════════════
TODAY'S MARKET INTELLIGENCE:
═══════════════════════════════════════════════════════════

RATES & MBS:
${intelligence.rates && intelligence.rates.bps_change ? JSON.stringify(intelligence.rates, null, 2) : "MBS data not available today."}

INDUSTRY NEWS (last 48 hours):
${intelligence.industryNews.length > 0 ? intelligence.industryNews.map((n, i) => `${i + 1}. [${n.source}] ${n.title}\n   ${n.summary || ""}\n   ${n.url || ""}`).join("\n") : "No new industry news."}

PIPELINE CONTEXT:
${intelligence.pipelineContext}

RECENT CONTENT POSTED (avoid repeating):
${intelligence.recentContent.length > 0 ? intelligence.recentContent.map(p => `${p.date} (${p.theme}): "${p.text}"`).join("\n") : "No recent posts."}

${intelligence.searchTrends ? `SEARCH TRENDS:\n${JSON.stringify(intelligence.searchTrends, null, 2)}` : ""}

${feedbackContext ? `VOICE CALIBRATION FEEDBACK:\n${feedbackContext}` : ""}

${options.customInstructions ? `SPECIAL INSTRUCTIONS: ${options.customInstructions}` : ""}

═══════════════════════════════════════════════════════════
OUTPUT FORMAT:
═══════════════════════════════════════════════════════════

Return a single JSON object with this exact schema:

{
  "briefingSummary": "Dan's 3-sentence executive summary of today — what matters, what to focus on, one thing to watch",

  "personalBriefing": {
    "marketContext": "2-3 sentences explaining what happened with rates/market and WHY — not just the numbers",
    "keyInsight": "The one thing John should understand today that he might not already know",
    "studyRecommendations": [
      { "title": "what to read/watch", "why": "why it matters for John specifically", "url": "link if available", "timeToConsume": "5 min" }
    ],
    "pipelineImplications": "How today's market conditions affect active deals — specific and actionable"
  },

  "contentRecommendations": [
    {
      "priority": 1,
      "topic": "The content topic/angle",
      "audience": "borrower|agent|both",
      "platforms": {
        "facebook": { "text": "The actual post text ready to publish", "format": "post|story|carousel", "scheduledTime": "HH:MM ET" },
        "x": { "text": "The X/Twitter version — shorter, punchier", "format": "tweet|thread", "scheduledTime": "HH:MM ET" },
        "linkedin": { "text": "LinkedIn version — professional but still John's voice", "format": "post|article|carousel", "scheduledTime": "HH:MM ET" }
      },
      "substackExpansion": null,
      "blogSEO": null,
      "videoCandidate": false,
      "visualNeeded": false,
      "visualDescription": null,
      "danNote": "Why this matters right now",
      "garyNote": "Distribution strategy for this piece",
      "alexNote": "The value this provides to the reader"
    }
  ],

  "newsletterIdeas": {
    "borrowerNewsletter": "Topic/angle for borrower monthly newsletter if anything is strong enough this week",
    "agentNewsletter": "Topic/angle for agent biweekly newsletter"
  },

  "weeklyVideoUpdate": {
    "topicSuggestion": "If it's Monday, suggest the weekly YouTube market update topic",
    "talkingPoints": ["point 1", "point 2", "point 3"],
    "scriptNeeded": true
  },

  "personaDebate": "2-3 sentence narrative of where Gary and Alex disagreed and why — this adds transparency to the decision-making"
}

RULES:
- Generate 1-3 content recommendations max. Quality over quantity.
- Each recommendation MUST include at least Facebook + one other platform version.
- Only include platforms where the content actually makes sense.
- If nothing newsworthy happened, say so — don't force content.
- Substack expansion only for truly strong pieces (1-2 per week max).
- videoCandidate = true only for topics that would work as a spoken market update.
- visualNeeded = true only when a graphic/infographic adds something the text can't convey alone.
- weeklyVideoUpdate only populated on Mondays.
- personalBriefing.studyRecommendations: max 2 items. Only flag things genuinely worth John's time.
- All content text must pass the "7am text to Jordan" test. If it sounds like a mortgage company wrote it, rewrite.`;
}

// ─── Claude API Call ───────────────────────────────────────────────

async function callClaude(prompt, { maxTokens = 4096, retries = 3 } = {}) {
  const key = ANTHROPIC_API_KEY();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const result = await resp.json();

      if (result.error?.type === "overloaded_error" && attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000)));
        continue;
      }

      if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

      return (result.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000)));
    }
  }
}

// ─── Briefing Actions ──────────────────────────────────────────────

function approveRecommendation(date, recId) {
  const briefing = loadBriefing(date);
  if (!briefing) return null;
  const rec = (briefing.contentRecommendations || []).find(r => r.id === recId);
  if (!rec) return null;
  rec.status = "approved";
  rec.approvedAt = new Date().toISOString();
  saveBriefing(briefing);
  return rec;
}

function rejectRecommendation(date, recId, reason) {
  const briefing = loadBriefing(date);
  if (!briefing) return null;
  const rec = (briefing.contentRecommendations || []).find(r => r.id === recId);
  if (!rec) return null;
  rec.status = "rejected";
  rec.rejectedAt = new Date().toISOString();
  rec.rejectionReason = reason || "";
  saveBriefing(briefing);
  return rec;
}

function markPublished(date, recId, platform) {
  const briefing = loadBriefing(date);
  if (!briefing) return null;
  const rec = (briefing.contentRecommendations || []).find(r => r.id === recId);
  if (!rec) return null;
  if (!rec.publishedPlatforms) rec.publishedPlatforms = [];
  if (!rec.publishedPlatforms.includes(platform)) {
    rec.publishedPlatforms.push(platform);
  }
  if (rec.publishedPlatforms.length > 0) rec.status = "published";
  saveBriefing(briefing);
  return rec;
}

// ─── Exports ───────────────────────────────────────────────────────

module.exports = {
  runDailyMeeting,
  loadBriefing,
  saveBriefing,
  listBriefings,
  getLatestBriefing,
  approveRecommendation,
  rejectRecommendation,
  markPublished,
};
