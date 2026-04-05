// Content Engine — Social media content generation for Anchor Mortgage
// Generates 2-week content plans, pulls from pipeline data, maintains voice consistency

const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA_DIR = path.join(__dirname, "data");
const CONTENT_FILE = path.join(DATA_DIR, "content-calendar.json");
const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || "";

// ─── Voice & Brand Rules ────────────────────────────────────────────

const VOICE_RULES = `VOICE & BRAND RULES FOR ALL CONTENT:
You are writing as John Hopkins III. Every post must sound like a text message to his business partner Jordan at 7am.

STYLE:
- Short sentences. Real words. No polish.
- Never use em dashes (—)
- Never sound like AI or a press release
- Never go negative on competitors
- No hashtags unless specifically requested
- No emojis unless they feel natural (rare)
- Sounds like a real person talking, not a company

JORDAN GERARD'S PRINCIPLES:
- Never go negative on competitors
- If you see weakness in the market, leverage it in your activities - not out your mouth
- Have conversations that benefit you - no need to bash anyone
- Build a castle that can't be penetrated and you won't have to worry about anything else
- Focus on you - your reputation, your stability, your relationships

THE BUS CONCEPT:
John's brand truth. He closes deals everyone else said were impossible. "When the bus pulls up to your loan save, it closes." This came from a real conversation with Jordan Gerard.

WHO JOHN IS:
- President & CEO of Anchor Mortgage Group (DBA of My Community Mortgage, NMLS #2408499)
- Mortgage broker in Hampton Roads, Virginia
- Specializes in VA loans, manual underwriting, complex cases nobody else will touch
- 99% close rate across 25+ states
- Neurodivergent (autism + ADHD) - exceptional pattern recognition, systems thinking
- Works best 4am-9am
- Education-first philosophy influenced by Alex Hormozi
- Core philosophy: "We don't motivate people. We design systems that remove the need for fear."

KEY AGENT RELATIONSHIPS (use for content inspiration, never name unless approved):
- Gabby Royals - three impossible closes, client called them Kobe and Shaq
- Wes Fertig - top 5 producing agent in Richmond, complex S-Corp income case
- John Upton - 5 year relationship, Hampton Roads
- Ivy Barnard - closed an impossible deal recently
- Greg Rosenberg, Alyicia Jordan, Julius Elemore, Efra Painter - active agent partners

TEAM:
- Corey McCullar - COO and personal partner (he/him). May review content.
- Brenda Corona - Processor
- Kat Pazzaglia - LO

SUBSTACK INTEGRATION:
- Every week, the best Bus Story (Monday) or strongest Win (Friday) should be flagged as that week's Substack candidate
- For the Substack candidate, generate TWO versions: the short punchy Facebook version AND a longer expanded Substack version
- Same voice on Substack. More depth. More narrative. Still sounds like John, just telling the full story.

TIMELY & MARKET AWARENESS:
- Flag when to reference VA loan awareness moments, rate changes, or housing market shifts
- NEVER frame as negativity or doom
- ALWAYS frame as "here's what this means for your buyers right now"
- Education first. Always.

RELATIONSHIP CONTEXT:
- Pipeline awareness isn't just deal status. Consider relationship health of the agent on each file.
- If an agent has an active file with delays or problems, don't celebrate smooth closings that week without flagging the potential tone conflict
- Deals and relationships are connected. Be thoughtful about what you celebrate and when.

THE ONE RULE ABOVE ALL:
Every post should sound like something John would text Jordan at 7am. If it sounds like a press release or a mortgage company's social media - rewrite it.`;

const CONTENT_FEEDBACK_FILE = path.join(DATA_DIR, "content-feedback.json");

function loadContentFeedback() {
  try { return JSON.parse(fs.readFileSync(CONTENT_FEEDBACK_FILE, "utf8")); }
  catch { return []; }
}

function saveContentFeedback(data) {
  fs.writeFileSync(CONTENT_FEEDBACK_FILE, JSON.stringify(data, null, 2));
}

// Record feedback on a post (what John edited and why)
function recordPostFeedback(postId, feedback) {
  const feedbackList = loadContentFeedback();
  feedbackList.push({
    postId,
    feedback,
    timestamp: new Date().toISOString(),
  });
  // Keep last 100
  if (feedbackList.length > 100) feedbackList.splice(0, feedbackList.length - 100);
  saveContentFeedback(feedbackList);
  return feedbackList;
}

// Build feedback context for prompt injection
function buildFeedbackContext() {
  const feedbackList = loadContentFeedback();
  if (feedbackList.length === 0) return "";

  const recent = feedbackList.slice(-10);
  const lines = ["VOICE CALIBRATION FEEDBACK (learn from these edits):"];
  for (const f of recent) {
    lines.push(`- "${f.feedback}"`);
  }
  return lines.join("\n");
}

const CONTENT_FRAMEWORK = {
  monday: {
    theme: "The Bus",
    description: "Deal stories. Impossible closes. Short and punchy. When the bus pulls up, it closes.",
    tone: "Confident. Brief. Let them wonder.",
  },
  tuesday: {
    theme: "The Truth",
    description: "Hard industry truths that make agents think. Never negative. Just real.",
    tone: "Direct. Educational. No names. No attacks. Just truth.",
  },
  wednesday: {
    theme: "The Person",
    description: "Who John is. Mission. Values. The neurodivergent brain as a superpower.",
    tone: "Personal. Vulnerable but strong. Unapologetic.",
  },
  thursday: {
    theme: "The Lesson",
    description: "Specific mortgage education. VA loans, manual underwriting, complex income, self-employed borrowers.",
    tone: "Teaching without lecturing. Position as expert without saying it.",
  },
  friday: {
    theme: "The Win",
    description: "Celebrate a close, a client, a teammate. Always ends with energy.",
    tone: "Celebratory. Warm. Ends with 'Happy Friday' energy.",
  },
};

// ─── Content CRUD ───────────────────────────────────────────────────

function loadContent() {
  try { return JSON.parse(fs.readFileSync(CONTENT_FILE, "utf8")); }
  catch { return { posts: [], generated: [] }; }
}

function saveContent(data) {
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(data, null, 2));
}

function getUpcomingPosts(days = 14) {
  const content = loadContent();
  const today = new Date().toISOString().split("T")[0];
  return (content.posts || []).filter(p => p.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, days);
}

function getPostsByDateRange(start, end) {
  const content = loadContent();
  return (content.posts || []).filter(p => p.date >= start && p.date <= end).sort((a, b) => a.date.localeCompare(b.date));
}

function updatePost(postId, updates) {
  const content = loadContent();
  const idx = (content.posts || []).findIndex(p => p.id === postId);
  if (idx === -1) return null;
  const allowed = ["text", "status", "platform", "notes", "substackTitle", "substackBody"];
  for (const key of allowed) {
    if (updates[key] !== undefined) content.posts[idx][key] = updates[key];
  }
  content.posts[idx].updatedAt = new Date().toISOString();
  saveContent(content);
  return content.posts[idx];
}

function deletePost(postId) {
  const content = loadContent();
  content.posts = (content.posts || []).filter(p => p.id !== postId);
  saveContent(content);
}

// ─── Pipeline Data Fetching ─────────────────────────────────────────

async function fetchPipelineContext() {
  const COMMAND_URL = process.env.COMMAND_API_URL || "https://anchorcommand.myanchormortgage.com";
  const API_KEY = process.env.COMMAND_API_KEY || "";

  try {
    const resp = await fetch(`${COMMAND_URL}/api/tasks/for-user?user=john@myanchormortgage.com`, {
      headers: { "X-API-Key": API_KEY, "X-Proxy-User": "content-engine" },
    });
    // This gives us tasks, but we need loan data. Use Dan's endpoint.
  } catch (e) {}

  // Try to get pipeline summary from Command
  try {
    const body = JSON.stringify({ question: "Give me a brief pipeline summary for content: loans closing this week, any recent wins, VA loans in progress, any complex/rescued deals. Be concise, just facts.", history: [] });
    const resp = await fetch(`${COMMAND_URL}/api/ai-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY, "X-Proxy-User": "content-engine" },
      body,
    });
    if (resp.ok) {
      const data = await resp.json();
      return data.response || "";
    }
  } catch (e) {
    console.error("[content-engine] Pipeline fetch error:", e.message);
  }

  return "No pipeline data available. Generate content based on general themes.";
}

// ─── Content Generation ─────────────────────────────────────────────

function getNextTwoWeeksDates() {
  const dates = [];
  const today = new Date();
  // Start from next Monday if today isn't Monday
  const dayOfWeek = today.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 0 : 8 - dayOfWeek;
  const startDate = new Date(today);
  startDate.setDate(today.getDate() + daysUntilMonday);

  for (let week = 0; week < 2; week++) {
    for (let day = 0; day < 5; day++) { // Mon-Fri
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + week * 7 + day);
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const dayName = dayNames[d.getDay()];
      if (CONTENT_FRAMEWORK[dayName]) {
        dates.push({
          date: d.toISOString().split("T")[0],
          dayName,
          ...CONTENT_FRAMEWORK[dayName],
        });
      }
    }
  }
  return dates;
}

async function generateTwoWeekPlan(pipelineContext, customInstructions) {
  const key = ANTHROPIC_API_KEY();
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const dates = getNextTwoWeeksDates();
  const dateList = dates.map(d => `${d.date} (${d.dayName}): ${d.theme} - ${d.description}`).join("\n");

  const prompt = `Generate a two-week content plan for John Hopkins III's social media.

${VOICE_RULES}

CONTENT FRAMEWORK:
${dateList}

CURRENT PIPELINE CONTEXT (use this for real, specific content):
${pipelineContext}

${customInstructions ? `ADDITIONAL INSTRUCTIONS: ${customInstructions}` : ""}

SAMPLE POSTS FOR VOICE CALIBRATION (match this exact tone):
Monday: "Got a call on a Friday afternoon. Deal was dead. Closing was in 9 days. Buyer was devastated. Agent was panicking. We closed in 9 days. When the bus pulls up, it closes."
Tuesday: "The pre-approval your client got somewhere else isn't always the ceiling. Sometimes it's just where the last lender stopped trying."
Wednesday: "My brain doesn't turn off. Ever. 4am I'm reading SEC filings. 6am I'm running income scenarios. 8am I'm on the phone with an underwriter. Most people would call that a problem. My clients call it their secret weapon."
Thursday: "VA loans are the most powerful mortgage product in America and the most misunderstood. No down payment. No PMI. And yes - they can be used more than once. If your veteran clients aren't using their benefit, someone didn't explain it right."
Friday: "A client told their agent this week that we're Kobe and Shaq. I don't know if I'm Kobe or Shaq. But I know we're closing deals other people said were impossible. Happy Friday. Go close something."

${buildFeedbackContext()}

SUBSTACK: For each week, flag the ONE best post as the Substack candidate (usually Monday's Bus Story or Friday's Win). For that post, also include a "substackTitle" and "substackBody" - a longer expanded version. Same voice, more depth, full narrative.

Respond with ONLY a JSON array (no markdown, no code fences). Each item:
{
  "date": "YYYY-MM-DD",
  "dayName": "monday",
  "theme": "The Bus",
  "platform": "facebook",
  "text": "The post text exactly as it should appear. No em dashes. No AI voice.",
  "notes": "Internal note about strategy/context for this post",
  "substackCandidate": false,
  "substackTitle": null,
  "substackBody": null
}

Set substackCandidate=true on the ONE best post per week. For that post, include substackTitle and substackBody with the expanded Substack version.

Generate exactly ${dates.length} posts. One per day, Monday through Friday, for two weeks. Every post must pass the test: "Would John text this to Jordan at 7am?" If no, rewrite it.`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  // Call Claude API with retries
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        }, res => {
          let d = "";
          res.on("data", c => d += c);
          res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
      });

      if (result.error?.type === "overloaded_error" && attempt < 3) {
        await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000)));
        continue;
      }

      if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

      const text = (result.content || []).filter(c => c.type === "text").map(c => c.text).join("");
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array in response");

      const posts = JSON.parse(jsonMatch[0]);

      // Enrich with IDs and metadata
      const enriched = posts.map(p => ({
        id: `post-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`,
        ...p,
        status: "draft", // draft | approved | posted
        createdAt: new Date().toISOString(),
      }));

      // Save to content calendar
      const content = loadContent();
      // Remove existing drafts for these dates
      const newDates = new Set(enriched.map(p => p.date));
      content.posts = (content.posts || []).filter(p => !newDates.has(p.date) || p.status === "posted");
      content.posts.push(...enriched);
      content.posts.sort((a, b) => a.date.localeCompare(b.date));

      // Track generation history
      if (!content.generated) content.generated = [];
      content.generated.push({
        timestamp: new Date().toISOString(),
        postCount: enriched.length,
        dateRange: `${enriched[0]?.date} to ${enriched[enriched.length - 1]?.date}`,
      });

      saveContent(content);
      console.log(`[content-engine] Generated ${enriched.length} posts for ${enriched[0]?.date} to ${enriched[enriched.length - 1]?.date}`);

      return enriched;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000)));
    }
  }
}

// Generate a single post for a specific day/theme
async function generateSinglePost(date, dayName, theme, pipelineContext, customInstructions) {
  const key = ANTHROPIC_API_KEY();
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const framework = CONTENT_FRAMEWORK[dayName] || {};

  const prompt = `Generate ONE social media post for ${date} (${dayName}).

${VOICE_RULES}

THEME: ${theme || framework.theme}
DESCRIPTION: ${framework.description || ""}
TONE: ${framework.tone || ""}

PIPELINE CONTEXT: ${pipelineContext || "Use general themes."}
${customInstructions ? `INSTRUCTIONS: ${customInstructions}` : ""}

Respond with ONLY a JSON object (no markdown):
{
  "text": "The post text exactly as it should appear",
  "notes": "Internal strategy note"
}`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

  const text = (result.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in response");

  const post = JSON.parse(jsonMatch[0]);
  const enriched = {
    id: `post-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 5)}`,
    date,
    dayName,
    theme: theme || framework.theme,
    platform: "facebook",
    text: post.text,
    notes: post.notes,
    status: "draft",
    createdAt: new Date().toISOString(),
  };

  const content = loadContent();
  if (!content.posts) content.posts = [];
  content.posts.push(enriched);
  content.posts.sort((a, b) => a.date.localeCompare(b.date));
  saveContent(content);

  return enriched;
}

module.exports = {
  VOICE_RULES,
  CONTENT_FRAMEWORK,
  loadContent,
  saveContent,
  getUpcomingPosts,
  getPostsByDateRange,
  updatePost,
  deletePost,
  generateTwoWeekPlan,
  generateSinglePost,
  fetchPipelineContext,
  getNextTwoWeeksDates,
  recordPostFeedback,
  loadContentFeedback,
};
