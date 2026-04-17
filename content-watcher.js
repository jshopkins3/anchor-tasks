// Content Watcher — Polls RSS feeds for mortgage industry content triggers
// Used by Anchor Tasks content intelligence feed
// Runs on setInterval every 2 hours

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const RSS_SOURCES = [
  {
    name: "HousingWire",
    url: "https://www.housingwire.com/feed/",
    icon: "HW",
    category: "industry",
  },
  {
    name: "Scotsman Guide",
    url: "https://www.scotsmanguide.com/feed/",
    icon: "SG",
    category: "industry",
  },
  {
    name: "MBA",
    url: "https://newslink.mba.org/feed/",
    icon: "MBA",
    category: "industry",
  },
  {
    name: "MPA",
    url: "https://www.mpamag.com/us/rss",
    icon: "MPA",
    category: "industry",
  },
  {
    name: "Greg Sher",
    url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCx0VPBGNEC3LB0BvFxkJrow",
    icon: "GS",
    category: "influencer",
  },
  // Borrower-sentiment signal — Reddit mortgage subs surface real confusion,
  // panic, and questions. Gold for Thursday Lesson posts ("things I keep
  // seeing in r/FirstTimeHomeBuyer that nobody explains right").
  {
    name: "r/Mortgages",
    url: "https://www.reddit.com/r/Mortgages/top.rss?t=day",
    icon: "RM",
    category: "borrower-sentiment",
  },
  {
    name: "r/FirstTimeHomeBuyer",
    url: "https://www.reddit.com/r/FirstTimeHomeBuyer/top.rss?t=day",
    icon: "FTH",
    category: "borrower-sentiment",
  },
  {
    name: "r/RealEstate",
    url: "https://www.reddit.com/r/RealEstate/top.rss?t=day",
    icon: "RE",
    category: "borrower-sentiment",
  },
];

// Simple XML tag extractor (no dependency needed)
function extractTag(xml, tag) {
  const open = `<${tag}>`;
  const openAlt = `<${tag} `;
  const close = `</${tag}>`;
  let start = xml.indexOf(open);
  if (start === -1) start = xml.indexOf(openAlt);
  if (start === -1) return "";
  const contentStart = xml.indexOf(">", start) + 1;
  const end = xml.indexOf(close, contentStart);
  if (end === -1) return "";
  let val = xml.substring(contentStart, end).trim();
  if (val.startsWith("<![CDATA[")) val = val.slice(9, val.endsWith("]]>") ? val.length - 3 : val.length);
  return val;
}

// Decode HTML entities and strip tags
function decodeEntities(str) {
  return str
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .trim();
}

// Extract all items/entries from RSS/Atom feed XML
function parseRSSItems(xml) {
  const items = [];
  const isAtom = xml.includes("<feed") && xml.includes("<entry>");
  const itemTag = isAtom ? "entry" : "item";
  const openTag = `<${itemTag}>`;
  const openTagAlt = `<${itemTag} `;
  const closeTag = `</${itemTag}>`;

  let pos = 0;
  while (pos < xml.length) {
    let start = xml.indexOf(openTag, pos);
    if (start === -1) start = xml.indexOf(openTagAlt, pos);
    if (start === -1) break;
    const end = xml.indexOf(closeTag, start);
    if (end === -1) break;
    const block = xml.substring(start, end + closeTag.length);

    const title = extractTag(block, "title");
    let link = "";
    if (isAtom) {
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/);
      link = linkMatch ? linkMatch[1] : "";
    } else {
      link = extractTag(block, "link");
    }
    const pubDate = extractTag(block, isAtom ? "published" : "pubDate") || extractTag(block, "updated");
    const description = extractTag(block, isAtom ? "summary" : "description") || extractTag(block, "content");
    const summary = decodeEntities(description).slice(0, 300);

    if (title) {
      items.push({ title: decodeEntities(title), link, pubDate, summary });
    }
    pos = end + closeTag.length;
  }
  return items;
}

// Fetch URL content (follows redirects)
function fetchURL(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error("Too many redirects"));
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "AnchorTasks/1.0 ContentWatcher" }, timeout: 15000 }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return resolve(fetchURL(resp.headers.location, redirectCount + 1));
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(new Error(`HTTP ${resp.statusCode}`));
      }
      let data = "";
      resp.on("data", chunk => data += chunk);
      resp.on("end", () => resolve(data));
      resp.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// Load existing triggers from disk
function loadTriggers() {
  const fp = path.join(DATA_DIR, "content-triggers.json");
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return { triggers: [], lastPoll: null };
  }
}

// Save triggers to disk (keep last 100)
function saveTriggers(data) {
  data.triggers = data.triggers.slice(0, 100);
  const fp = path.join(DATA_DIR, "content-triggers.json");
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

// Check if a trigger already exists
function isDuplicate(existing, item, source) {
  return existing.some(t =>
    (t.link && t.link === item.link) ||
    (t.title === item.title && t.source === source)
  );
}

// Main poll function
async function pollFeeds() {
  const data = loadTriggers();
  const existingTriggers = data.triggers || [];
  let newCount = 0;
  const results = [];

  for (const source of RSS_SOURCES) {
    try {
      const xml = await fetchURL(source.url);
      const items = parseRSSItems(xml);
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 48);

      for (const item of items.slice(0, 10)) {
        if (isDuplicate(existingTriggers, item, source.name)) continue;

        if (item.pubDate) {
          const itemDate = new Date(item.pubDate);
          if (!isNaN(itemDate.getTime()) && itemDate < cutoff) continue;
        }

        const trigger = {
          id: `${source.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          source: source.name,
          sourceIcon: source.icon,
          category: source.category,
          title: item.title,
          link: item.link,
          summary: item.summary,
          pubDate: item.pubDate || new Date().toISOString(),
          fetchedAt: new Date().toISOString(),
          status: "new",
          reactedContent: null,
        };

        existingTriggers.unshift(trigger);
        newCount++;
      }

      results.push({ source: source.name, itemsFetched: items.length, status: "ok" });
    } catch (err) {
      results.push({ source: source.name, itemsFetched: 0, status: "error", error: err.message });
    }
  }

  data.triggers = existingTriggers;
  data.lastPoll = new Date().toISOString();
  saveTriggers(data);

  console.log(`[content-watcher] Polled ${RSS_SOURCES.length} sources, ${newCount} new triggers (${existingTriggers.length} total)`);
  return { newCount, total: existingTriggers.length, results };
}

// Add a webhook trigger (from Zapier, etc.)
function addWebhookTrigger({ source, title, summary, link, author, category }) {
  const data = loadTriggers();
  const trigger = {
    id: `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    source: source || "Zapier Webhook",
    sourceIcon: source === "LinkedIn" ? "LI" : "ZAP",
    category: category || "influencer",
    title,
    link: link || "",
    summary: summary || "",
    author: author || "",
    pubDate: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    status: "new",
    reactedContent: null,
  };
  data.triggers = data.triggers || [];
  data.triggers.unshift(trigger);
  data.triggers = data.triggers.slice(0, 100);
  saveTriggers(data);
  console.log(`[content-watcher] Webhook trigger: "${title}" from ${source || "unknown"}`);
  return trigger;
}

// Get triggers with optional filter
function getTriggers({ status, limit } = {}) {
  const data = loadTriggers();
  let triggers = data.triggers || [];
  if (status && status !== "all") triggers = triggers.filter(t => t.status === status);
  if (limit) triggers = triggers.slice(0, limit);
  return { triggers, lastPoll: data.lastPoll, total: triggers.length };
}

// Update a trigger's status
function updateTrigger(id, updates) {
  const data = loadTriggers();
  const trigger = (data.triggers || []).find(t => t.id === id);
  if (!trigger) return null;
  if (updates.status) trigger.status = updates.status;
  if (updates.reactedContent) trigger.reactedContent = updates.reactedContent;
  trigger.updatedAt = new Date().toISOString();
  saveTriggers(data);
  return trigger;
}

module.exports = {
  pollFeeds,
  addWebhookTrigger,
  getTriggers,
  updateTrigger,
  loadTriggers,
  RSS_SOURCES,
};
