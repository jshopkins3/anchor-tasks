// Market Data Aggregator — Gathers intelligence from all sources for the daily marketing meeting
// Sources: RSS feed, MBS rates, pipeline context, content feedback, social analytics

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const BM_API_URL = process.env.BROKER_MARKETPLACE_URL || "https://mortgagemarketplace.ai";
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
    const resp = await fetch(`${BM_API_URL}/api/mbs-data/latest`, {
      headers: { Authorization: `Bearer ${BM_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`MBS API ${resp.status}`);
    return await resp.json();
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

  const today = new Date();
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayOfWeek = dayNames[today.getDay()];

  const intelligence = {
    date: today.toISOString().substring(0, 10),
    dayOfWeek,
    timestamp: today.toISOString(),

    // Market data
    rates: mbsData || { note: "MBS data unavailable — BM_API_KEY not configured" },

    // Industry news from RSS
    industryNews: rssTriggers.map(t => ({
      title: t.title,
      source: t.source,
      summary: t.summary || "",
      url: t.url || "",
      publishedAt: t.publishedAt || t.createdAt,
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
  getRecentTriggers,
  getRecentPosts,
  getContentFeedback,
};
