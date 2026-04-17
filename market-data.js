// Market Data Aggregator — Gathers intelligence from all sources for the daily marketing meeting
// Sources: RSS feed, MBS rates, pipeline context, content feedback, social analytics

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const BM_API_URL = process.env.BROKER_MARKETPLACE_URL || "https://broker-marketplace.com";
const BM_API_KEY = process.env.BM_API_KEY || "";

// ─── RSS Intelligence (from content-watcher.js) ────────────────────

function getRecentTriggers(hours = 48) {
  try {
    const cw = require("./content-watcher");
    const result = cw.getTriggers({ status: "new", limit: 20 });
    return result.triggers || [];
  } catch (e) {
    console.error("[market-data] RSS triggers error:", e.message);
    return [];
  }
}

// ─── MBS / Rate Data (from Broker Marketplace API) ─────────────────

async function fetchMBSData() {
  if (!BM_API_KEY) {
    console.log("[market-data] BM_API_KEY not set, skipping MBS data");
    return null;
  }
  try {
    const url = `${BM_API_URL}/api/mbs-data/latest`;
    console.log("[market-data] Fetching MBS from:", url);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${BM_API_KEY}` },
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error("[market-data] MBS API error:", resp.status, body.substring(0, 200));
      throw new Error(`MBS API ${resp.status}`);
    }
    const data = await resp.json();
    console.log("[market-data] MBS response keys:", data ? Object.keys(data) : "null");
    return data;
  } catch (e) {
    console.error("[market-data] MBS fetch error:", e.message);
    return null;
  }
}

// ─── Broker Marketplace Templates & Videos ─────────────────────────

async function fetchBMTemplates(limit = 10) {
  if (!BM_API_KEY) return [];
  try {
    const resp = await fetch(`${BM_API_URL}/api/templates/library?limit=${limit}`, {
      headers: { Authorization: `Bearer ${BM_API_KEY}` },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.templates || data || [];
  } catch (e) {
    console.error("[market-data] Templates fetch error:", e.message);
    return [];
  }
}

async function fetchBMVideos(limit = 10) {
  if (!BM_API_KEY) return [];
  try {
    const resp = await fetch(`${BM_API_URL}/api/videos/library?limit=${limit}`, {
      headers: { Authorization: `Bearer ${BM_API_KEY}` },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.videos || data || [];
  } catch (e) {
    console.error("[market-data] Videos fetch error:", e.message);
    return [];
  }
}

// ─── Pipeline Context (from content-engine.js) ─────────────────────

async function fetchPipelineContext() {
  try {
    const contentEngine = require("./content-engine");
    return await contentEngine.fetchPipelineContext();
  } catch (e) {
    console.error("[market-data] Pipeline context error:", e.message);
    return "No pipeline data available.";
  }
}

// ─── Rate Context (Claude narrates WHY MBS/Treasury moved) ──────────
// Takes raw MBS numbers + today's macro headlines, returns a 2-3 sentence
// narrative about what's driving the move and what it means for borrowers.
// Cached per-day — rates settle once a day, no need to recompute hourly.

let rateContextCache = { context: null, forDate: "", computedAt: 0 };
const RATE_CONTEXT_CACHE_MS = 4 * 60 * 60 * 1000; // 4 hours

async function deriveRateContext(mbsData, industryNews) {
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (!key || !mbsData) return null;

  const today = new Date().toISOString().substring(0, 10);
  if (rateContextCache.forDate === today && rateContextCache.context && Date.now() - rateContextCache.computedAt < RATE_CONTEXT_CACHE_MS) {
    return rateContextCache.context;
  }

  // Pull macro-relevant headlines — Fed, CPI, jobs, Treasury, inflation, Powell, rate cut
  const macroKeywords = /\b(fed|fomc|powell|cpi|ppi|inflation|jobs report|payroll|treasury|yield|bond|rate cut|hike|hawkish|dovish|gdp|housing starts|existing home sales|mortgage rate)\b/i;
  const macroHeadlines = (industryNews || [])
    .filter(n => macroKeywords.test(`${n.title} ${n.summary || ""}`))
    .slice(0, 10)
    .map(n => `- [${n.source}] ${n.title}${n.summary ? " — " + n.summary.substring(0, 200) : ""}`)
    .join("\n");

  const mbsSummary = JSON.stringify(mbsData);
  const prompt = `You are a mortgage rate analyst briefing John Hopkins, a broker. Today's rate data:
${mbsSummary}

Recent macro-relevant headlines (last 48hrs):
${macroHeadlines || "No macro-specific headlines — use general context."}

Write a 3-4 sentence RATE CONTEXT narrative that covers:
1. What MBS/Treasury did (reference the bps change or direction)
2. The most likely DRIVER (tie to a specific event or data print if headlines suggest one; otherwise say "no clear catalyst")
3. What it means for BORROWERS (should floaters lock? is there a window? is this noise?)
4. What it means for ACTIVE PIPELINE (any loans at risk of repricing if trend continues?)

Rules:
- No em dashes. Hyphens or semicolons only.
- Speak directly to John, not third-person.
- Be honest — if you don't know the driver, say "no clear catalyst" instead of inventing one.
- Max 4 sentences. Dense, actionable.
- No hedging like "it depends" or "markets are complex" — pick a read.

Return ONLY the narrative text, no preamble.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.content || []).find(c => c.type === "text")?.text?.trim() || null;
    if (text) rateContextCache = { context: text, forDate: today, computedAt: Date.now() };
    return text;
  } catch (e) {
    console.error("[market-data] Rate context error:", e.message);
    return null;
  }
}

// ─── Emerging Themes (Claude-extracted patterns across RSS triggers) ────
// Same extraction the /api/content-feed?grouped=1 endpoint does — pulled here
// so the briefing can reason from PATTERNS not individual headlines. Cached
// module-level for 1 hour to avoid re-running per request.

let themesCache = { themes: [], computedAt: 0, triggerIds: "" };
const THEMES_CACHE_MS = 60 * 60 * 1000; // 1 hour

async function extractThemes(triggers) {
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (!key || !triggers || triggers.length < 3) return [];

  // Cache key based on trigger IDs — if the feed hasn't changed, skip re-extraction
  const triggerIds = triggers.slice(0, 25).map(t => t.id).sort().join(",");
  if (themesCache.triggerIds === triggerIds && Date.now() - themesCache.computedAt < THEMES_CACHE_MS) {
    return themesCache.themes;
  }

  const headlines = triggers.slice(0, 25).map(t => `[${t.source}] ${t.title}`).join("\n");

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        messages: [{ role: "user", content: `You are analyzing mortgage industry news headlines for a loan officer. Identify 2-4 emerging THEMES from these headlines. Each theme should be a short phrase (3-6 words) with a 1-sentence explanation of why it matters to a mortgage broker. Return ONLY valid JSON, no markdown.

Headlines:
${headlines}

Return: {"themes":[{"theme":"short phrase","why":"1 sentence why it matters","count":N,"emoji":"relevant emoji"}]}` }],
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const text = (data.content || []).find(c => c.type === "text")?.text || "{}";
    const parsed = JSON.parse(text.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
    const themes = parsed.themes || [];
    themesCache = { themes, computedAt: Date.now(), triggerIds };
    return themes;
  } catch (e) {
    console.error("[market-data] Theme extraction error:", e.message);
    return [];
  }
}

// ─── Content Performance / Feedback ────────────────────────────────

function getContentFeedback() {
  try {
    const contentEngine = require("./content-engine");
    return contentEngine.loadContentFeedback();
  } catch { return []; }
}

function getRecentPosts() {
  try {
    const contentEngine = require("./content-engine");
    const content = contentEngine.loadContent();
    const posts = content.posts || [];
    // Last 14 days of posts
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().substring(0, 10);
    return posts.filter(p => p.date >= twoWeeksAgo).sort((a, b) => b.date.localeCompare(a.date));
  } catch { return []; }
}

// ─── Aggregate All Intelligence ────────────────────────────────────

async function gatherMarketIntelligence() {
  console.log("[market-data] Gathering market intelligence...");

  const [
    rssTriggers,
    mbsData,
    pipelineContext,
    recentPosts,
    contentFeedback,
  ] = await Promise.all([
    Promise.resolve(getRecentTriggers()),
    fetchMBSData(),
    fetchPipelineContext(),
    Promise.resolve(getRecentPosts()),
    Promise.resolve(getContentFeedback()),
  ]);

  // Extract emerging themes — this is the primary industry signal for the
  // briefing. Gary and Alex reason from patterns first, headlines as backup.
  const emergingThemes = await extractThemes(rssTriggers);

  // Derive rate context narrative — why did MBS/Treasury move, what it means
  // for borrowers + pipeline. Feeds into briefing prompt.
  const rateContext = await deriveRateContext(mbsData, rssTriggers.map(t => ({
    title: t.title, source: t.source, summary: t.summary || "",
  })));

  const today = new Date();
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayOfWeek = dayNames[today.getDay()];

  const intelligence = {
    date: today.toISOString().substring(0, 10),
    dayOfWeek,
    timestamp: today.toISOString(),

    // Market data
    rates: mbsData || { note: "MBS data unavailable — BM_API_KEY not configured" },
    rateContext, // AI-generated narrative on WHY rates moved + what it means

    // Emerging themes — top-level signal for briefing reasoning
    emergingThemes,

    // Industry news from RSS (supporting evidence)
    industryNews: rssTriggers.map(t => ({
      title: t.title,
      source: t.source,
      summary: t.summary || "",
      url: t.link || t.url || "",
      publishedAt: t.pubDate || t.fetchedAt || t.createdAt || "",
    })),

    // Pipeline
    pipelineContext,

    // What's been posted recently
    recentContent: recentPosts.slice(0, 10).map(p => ({
      date: p.date,
      theme: p.theme,
      platform: p.platform,
      status: p.status,
      text: (p.text || "").substring(0, 200),
    })),

    // Feedback/calibration
    feedbackHistory: (contentFeedback || []).slice(-5).map(f => f.feedback),

    // Ahrefs data placeholder — filled in by marketing-engine if MCP tools available
    searchTrends: null,
    gscData: null,
    socialAnalytics: null,
  };

  console.log(`[market-data] Intelligence gathered: ${intelligence.industryNews.length} news items, rates: ${mbsData ? "yes" : "no"}, pipeline: ${pipelineContext ? "yes" : "no"}`);

  return intelligence;
}

module.exports = {
  gatherMarketIntelligence,
  fetchMBSData,
  fetchBMTemplates,
  fetchBMVideos,
  fetchPipelineContext,
  extractThemes,
  deriveRateContext,
  getRecentTriggers,
  getRecentPosts,
  getContentFeedback,
};
