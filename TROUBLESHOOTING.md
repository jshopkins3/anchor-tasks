# John's Troubleshooting Guide

A practical guide for debugging Anchor Command + Anchor Tasks without needing to read code.

Built 2026-04-17. Living doc — Claude will add new patterns as we encounter them.

---

## How to use this guide

**When something breaks:**
1. Do a quick **self-check** (section below) — 5-10 minutes, often fixes it
2. If that fails, **gather evidence** using DevTools (section below)
3. Ping Claude with the **bug report template** — fastest path to a real fix

**The goal:** you don't become a programmer. You become a good reporter. The more precise your observation, the faster Claude diagnoses.

---

## Self-check — try these first (5-10 min)

Before pinging Claude, rule out the easy stuff:

### 1. Is it just you?
- **Hard refresh** (Ctrl+Shift+R on Windows, Cmd+Shift+R on Mac) — bypasses cache
- **Incognito window** → log in → does it still happen?
  - Yes → real bug, ping Claude
  - No → your browser has stale cache/cookies/service worker, use "Full cache clear" below

### 2. Did it just happen after a deploy?
- Wait 2-3 minutes, refresh → often resolves itself
- Railway deploys take 60-90 seconds; during that window, the app can hiccup

### 3. Full cache clear (when hard refresh isn't enough)
DevTools → **Application** tab → **Storage** section → click **Clear site data** button → hard refresh
- This nukes cookies, service worker, local storage
- You'll need to log back in
- Fixes ~30% of "weird is happening" bugs

### 4. Unregister the service worker manually
DevTools → **Application** → **Service Workers** → click **Unregister** next to the service worker → hard refresh
- Use when new features aren't showing up even after cache clear

### 5. Try another browser
Chrome/Edge/Firefox/Safari — if it works in one but not another, it's browser-specific (uncommon but happens)

### 6. Check a different tab/account
If you can reproduce on another logged-in user (Kat, Brenda, Corey), it's a global bug
If only you hit it, it's user-specific (session, personalization, data issue)

---

## DevTools crash course

Press **F12** (Windows) or **Cmd+Option+I** (Mac) to open. Three tabs matter:

### Console tab

**What it shows:** log messages, errors, warnings from the page
**When to check:** anytime something feels wrong, check here FIRST

**What to look for:**
- **Red text** = errors (something broke)
- **Yellow text** = warnings (works but not ideal)
- **Gray/black** = normal info messages

**Common things you'll see:**

| Message | What it means |
|---|---|
| `[hub] MBS raw: {...}` | Normal — hub loaded rates |
| `[hub] Pipeline fetch failed: 503` | Bug — pipeline couldn't load (with our new code) |
| `GET .../api/xyz 401 (Unauthorized)` | Session expired — log in again |
| `GET .../api/xyz 500` | Server error — ping Claude |
| `Service Worker was updated because "Update on reload" was checked` | Normal if you have that DevTools setting on |
| `Uncaught (in promise) Error: A listener indicated...` | Chrome extension noise — ignore |
| `Cannot read property 'X' of undefined` | Code tried to access something that doesn't exist — ping Claude |

**What to tell Claude:**
Copy-paste the whole error (or screenshot). Include the 2-3 lines before it — context matters.

### Network tab

**What it shows:** every request the page makes (API calls, images, scripts)
**When to check:** button doesn't work, data missing, page is slow

**How to read it:**

1. Open Network tab
2. Refresh the page (or trigger the action that's broken)
3. Look at the **Status** column:
   - **200-299** = success (green)
   - **300-399** = redirect (usually fine)
   - **400-499** = client's fault (you, the browser, the request) — 401 = auth, 404 = not found
   - **500-599** = server's fault (Railway, the API, backend code)
4. Click a failing request → see:
   - **Headers** tab: what was sent, what came back
   - **Response** tab: the actual body of the response (error message, data)
   - **Preview** tab: formatted response

**What to tell Claude:**
- The URL that failed
- The status code
- The response body (if it's an error, copy the message)

**Shortcut:** filter by clicking **Fetch/XHR** — hides images/scripts, shows only API calls

### Application tab

**What it shows:** storage, cookies, service workers, cached files
**When to check:** PWA weirdness, stuck on old version, auth issues

**Useful sections:**

| Section | What it does |
|---|---|
| **Service Workers** | Shows the SW, lets you unregister or force update |
| **Storage → Cookies** | Your session cookies (rarely need to touch) |
| **Storage → Local Storage** | App settings saved in your browser (theme, filters) |
| **Cache Storage** | What the service worker is caching |
| **Clear site data** button | Nuclear option — wipes everything |

---

## Bug report template

When you ping Claude, include as many of these as you can:

```
WHAT I SAW:
[One sentence describing the symptom]

WHAT I EXPECTED:
[What should have happened instead]

WHEN IT STARTED:
[Just now / After this morning's deploy / Last week / Always]

WHERE (which page/feature):
[Hub / Marketing Command Center → Briefing / Pipeline detail / etc.]

HOW TO REPRODUCE:
1. [Step]
2. [Step]
3. [Step]

CONSOLE OUTPUT:
[Paste any errors/warnings]

NETWORK TAB (if relevant):
[Failed request URL and status code]

ALREADY TRIED:
- Hard refresh: [Y/N]
- Incognito: [same behavior? Y/N]
- Different browser: [same behavior? Y/N]
```

Not every field matters every time — skip what's not relevant. But even "what I saw + where + console output" is 10x better than "it's broken."

---

## Common patterns — what they usually mean

### "It worked yesterday, doesn't work today"
- **Most likely:** a deploy changed something
- **Check:** recent commits in git log
- **Say to Claude:** "Worked yesterday, broke today — check recent commits"

### "It's inconsistent — sometimes works, sometimes not"
- **Most likely:** caching, race condition, or external API flakiness
- **Check:** does it correlate with anything? Time of day? Specific loan? Specific user?
- **Say to Claude:** "Intermittent — happens about X% of the time when Y"

### "Changes I made aren't showing up"
- **Most likely:** service worker serving cached version
- **Try:** full cache clear (Application → Clear site data)
- **Say to Claude if persists:** "Still seeing old version after cache clear"

### "It loads forever / spinner never stops"
- **Check:** Network tab — is there a pending request?
- **If yes:** which endpoint? Status code?
- **If no:** JavaScript error — check Console for red text

### "Button does nothing"
- **Check Console:** any errors when you click?
- **Check Network:** did any request get made?
  - No request → JavaScript error (event handler broken)
  - Request sent, got error → server issue
  - Request sent, got 200 → response handler broken

### "Data is wrong / missing"
- **Check Network:** find the API call, look at the response
- **Is the data in the response?**
  - Yes but UI shows wrong → frontend rendering bug
  - No → backend issue (API, database, data sync)

### "Only happens for one loan/user/contact"
- **Check:** what's different about that one?
- **Often:** missing field, weird data format, edge case in parsing
- **Say to Claude:** "Only happens for [specific item], working for others"

### "401 Unauthorized errors"
- **Session expired.** Log out and back in.
- If persistent after login, Claude should check auth flow

### "503 Service Unavailable"
- **Railway deploy in progress** (temporary) or **service actually down**
- Wait 2 minutes, retry
- If persistent, check Railway dashboard

### "Favicon 404" or similar minor
- Cosmetic, doesn't break anything
- Flag to Claude but low priority

---

## When to ping Claude immediately (skip self-check)

- **Data loss risk:** a button that might delete/overwrite something is misbehaving
- **Security-looking:** anything mentioning auth, permissions, unexpected access
- **Broken for the team:** Brenda/Corey/Kat can't work
- **Repeating bug:** same thing you've seen before — faster to ask than re-diagnose

---

## When to give up and ask Claude

Don't waste more than 15 minutes on self-check unless you're enjoying it. Your time is worth more than mine (literally — I'm free). Give me:

1. Symptom
2. Steps to reproduce  
3. Console output
4. What you already tried

I'll take it from there.

---

## Living document

Claude will add new patterns to this guide as we encounter them. If you solve a bug and realize it'd be useful to capture the pattern here, tell Claude: *"add this to the troubleshooting guide."*

Last updated: 2026-04-17 (initial version)
