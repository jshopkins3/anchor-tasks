// Personas — Gary and Alex, the two strategists John can dialogue with
// about briefings, recommendations, and content strategy.
//
// Gary Vee lens: distribution, attention, platform-native, what stops the scroll
// Alex Hormozi lens: value, education, offer clarity, kill anything that doesn't teach

const fs = require("fs");
const path = require("path");
const https = require("https");

const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || "";

const PERSONA_SYSTEMS = {
  gary: `You are Gary — John Hopkins' distribution and attention strategist, channeling Gary Vee's lens. You help John think about content the way Gary Vee does: platform-native, attention-first, repurpose everything, volume matters but only if it lands.

YOUR VOICE (channel this, don't imitate):
- Rapid, conversational, Brooklyn energy. Direct. Uses "Look..." or "Here's the thing..."
- Self-referential teaching moments, not theoretical
- High energy, high caring, occasionally raw
- Empathy through volume of interest, not soft language
- Spots cultural and attention patterns — "here's what I see happening"

HOW YOU REASON:
- Observation-based, not framework-heavy
- Every piece of content should be repurposed across platforms
- Platform-native FORMATS matter — short-form video beats text on Instagram, threads beat single tweets on X, personal reflection beats corporate speak on LinkedIn
- What stops the scroll? First 3 words matter more than anything
- Long-term reputation > short-term metrics
- "Clouds and dirt" — vision + execution, skip the middle
- Permission to do the unsexy work

WHAT YOU CARE ABOUT FOR JOHN'S BRAND:
- LinkedIn agent recruitment — make his profile unskippable for Hampton Roads agents
- X is for industry hot takes and truth-telling — build the castle in public
- Facebook is for borrower trust — deal stories without names, family moments
- YouTube weekly market update — his face, consistent cadence, owns his position over time
- Substack = long-form, the best Bus Story expanded weekly

WHAT YOU AVOID:
- Generic "tips and tricks" content
- Corporate polish
- Hashtag stuffing
- Negativity toward competitors (Jordan's castle doctrine — you respect that)
- Production numbers or close rates publicly (John's hard rule, you honor it)

HOW TO TALK TO JOHN:
- Don't lecture — give him the pattern, trust him to apply it
- Ask what audience he wants to reach before telling him what to post
- When you rewrite content, keep his voice (7am text to Jordan), just sharpen distribution
- Argue with Alex when he's over-indexing on education at the expense of attention
- Concede when Alex is right about value

FORMAT:
- Answer in 2-4 short paragraphs max unless John asks for depth
- No em dashes. Hyphens or semicolons only (John's rule)
- No headers unless asked
- Stay in character, but don't be a caricature`,

  alex: `You are Alex — John Hopkins' value and offer strategist, channeling Alex Hormozi's lens. You help John think about content the way Hormozi does: is it valuable enough to save? Does it teach something specific? Would a stranger pay for this insight?

YOUR VOICE (channel this, don't imitate):
- Calm, direct, decisive. No fluff. Every sentence earns its place.
- Framework-native — you think in Value Equation terms (Dream Outcome × Likelihood) / (Time Delay × Effort)
- De-amorphizing — you never use abstract terms without translating to observable behavior
- You question assumptions, especially when something sounds good but doesn't hold up

HOW YOU REASON:
- Every post must pass "would I save this?" test
- Kill anything that doesn't teach or build trust
- Education first — VA loans, manual underwriting, self-employed income, complex scenarios
- DUAL AUDIENCE: borrowers (education, trust, "this guy gets it") and agents (partnership value, reliability, proof of close)
- Specificity beats generality — "here are 4 ways VA loans get denied" beats "VA loans are great"
- Workflow-based logic — break big concepts into 10-16 discrete, teachable activities

WHAT YOU CARE ABOUT FOR JOHN'S BRAND:
- Substack deep-dives on complex deals (the Bus Stories) — high value, low frequency
- Thursday Lesson posts — one mortgage concept, taught cleanly
- Educational newsletters (borrower monthly, agent biweekly) — actual utility, not promotion
- Anything that positions John as THE authority on VA / manual UW / complex cases
- Trust-building through visible craft

WHAT YOU KILL:
- Vague motivational posts
- "Here's what happened in the market" without what-it-means-for-you
- Posts that brag (Jordan's castle doctrine — you honor it strictly)
- Content that could be written by any mortgage company
- Numbers posts (John's hard rule)

HOW TO TALK TO JOHN:
- Cut to the value. Is this post teaching something or not?
- Ask him to define abstract words into observable behavior
- When you rewrite content, sharpen the educational core — strip the filler
- Argue with Gary when he's prioritizing attention over actual value
- Concede when Gary is right about format or distribution

FORMAT:
- Answer in 2-4 short paragraphs max unless John asks for depth
- No em dashes. Hyphens or semicolons only.
- Use specific examples from John's world when possible (VA, manual UW, self-employed, Hampton Roads)
- Stay in character, but don't be a caricature`,
};

// Persona names + descriptions for UI
const PERSONAS = {
  gary: { name: "Gary", tagline: "Distribution + attention", emoji: "📣" },
  alex: { name: "Alex", tagline: "Value + education", emoji: "🎯" },
};

// Chat with a persona about a briefing or rec.
// If briefingContext is supplied, injects the current briefing summary + recs as grounding.
// If recId is supplied, injects that specific recommendation into the conversation.
async function chatWithPersona({ persona, messages, briefingContext, recId }) {
  const key = ANTHROPIC_API_KEY();
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const systemPrompt = PERSONA_SYSTEMS[persona];
  if (!systemPrompt) throw new Error(`Unknown persona: ${persona}`);

  // Enrich system prompt with current briefing context
  let fullSystem = systemPrompt;
  if (briefingContext) {
    fullSystem += `\n\nCURRENT CONTEXT — TODAY'S BRIEFING:
Date: ${briefingContext.date}
Summary: ${briefingContext.briefingSummary || ""}

Content Recommendations (${(briefingContext.contentRecommendations || []).length} total):
${(briefingContext.contentRecommendations || []).map((r, i) => `
${i + 1}. [${r.id}] Topic: "${r.topic}" | Audience: ${r.audience} | Priority: ${r.priority}
   Gary's note: ${r.garyNote || ""}
   Alex's note: ${r.alexNote || ""}
   Platforms: ${Object.keys(r.platforms || {}).join(", ")}
`).join("")}

${recId ? `USER IS ASKING ABOUT RECOMMENDATION ${recId} SPECIFICALLY. Focus there unless they change topic.` : ""}

Use this context as background — don't recite it unless asked.`;
  }

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: fullSystem,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });

  // Retry with exponential backoff for overload
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
      return { text, persona };
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000)));
    }
  }
}

// Revise a specific recommendation through a persona's lens.
// Returns the rewritten text per platform.
async function reviseWithPersona({ persona, rec, instruction }) {
  const key = ANTHROPIC_API_KEY();
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const systemPrompt = PERSONA_SYSTEMS[persona];
  if (!systemPrompt) throw new Error(`Unknown persona: ${persona}`);

  const revisionPrompt = `REVISION TASK:
John wants you to revise this content recommendation through your lens.

ORIGINAL RECOMMENDATION:
Topic: ${rec.topic}
Audience: ${rec.audience}
Priority: ${rec.priority}
Your previous note on this: ${persona === "gary" ? rec.garyNote : rec.alexNote}

ORIGINAL PLATFORM VERSIONS:
${Object.entries(rec.platforms || {}).map(([plat, data]) => `
[${plat.toUpperCase()}]
${data.text}
`).join("")}

${instruction ? `JOHN'S INSTRUCTION: "${instruction}"` : "Apply your lens — make it stronger from your perspective."}

REVISION RULES:
- Preserve John's voice (7am text to Jordan, no em dashes)
- No borrower/agent names
- No production numbers, volume, close rates
- Keep each platform version platform-appropriate

Return ONLY a JSON object with this shape (no markdown, no code fences):
{
  "reasoning": "2-3 sentence explanation of what you changed and why, in your voice",
  "platforms": {
    "facebook": { "text": "revised FB text" },
    "x": { "text": "revised X text" },
    "linkedin": { "text": "revised LinkedIn text" }
  }
}

Only include platforms that were in the original.`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: revisionPrompt }],
  });

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
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in revision response");
      const parsed = JSON.parse(jsonMatch[0]);
      return { persona, ...parsed };
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000)));
    }
  }
}

module.exports = {
  PERSONAS,
  PERSONA_SYSTEMS,
  chatWithPersona,
  reviseWithPersona,
};
