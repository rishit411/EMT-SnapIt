# SnapTrip + TripSync
### AI-Powered Visual Trip Discovery & Group Travel Planner for EaseMyTrip

---

## What is this?

Two AI features built on EaseMyTrip's design system, powered by Google Gemini:

**SnapTrip** - Upload any travel photo (Instagram, Pinterest, WhatsApp, screenshot) and instantly get a complete destination guide: crowd calendar, visa requirements, real budget breakdown, curated day-by-day itinerary, local guide, packing list, and insider tips. Refine the trip conversationally ("make it 5 days", "travelling with kids") and the itinerary updates live.

**TripSync** - Group travel planner that works with your SnapTrip itinerary. Add each person in your group (name, travel vibe, budget), pick dates, and AI generates 3 package options built around the destination you already chose - with a per-person happiness score showing what each traveller loves and what they compromise on.

---

## Quick Start
Vercel link - https://emt-snap-it.vercel.app/
### Prerequisites
- Node.js 18+ — https://nodejs.org (LTS version)
- A free Gemini API key — https://aistudio.google.com/app/apikey

### Setup

```bash
# 1. Unzip and enter the project
cd snaptrip

# 2. Install dependencies
npm install

# 3. Add your Gemini API key
# Open .env and replace the placeholder:
# GEMINI_API_KEY=AIzaYourActualKeyHere

# 4. Start
npm start

# 5. Open browser
# http://localhost:3000
```

---

## Project Structure

```
snaptrip/
├── server.js          - Express backend + Gemini API proxy (4 routes)
├── package.json       - Dependencies
├── .env               - Your Gemini API key (never commit this)
├── .gitignore         - Excludes node_modules, .env, OS files
├── public/
│   └── index.html     - Complete frontend (CSS + JS inline, single file)
└── README.md          - This file
```

---

## Architecture

```
Browser (index.html)
    |
    | POST /api/snap/analyze    (image upload or URL)
    | POST /api/snap/refine     (conversational refinement)
    | POST /api/snap/packlist   (packing list generation)
    | POST /api/tripsync/plan   (group package generation)
    |
Express server (server.js)
    |
    | Gemini 2.5 Flash (primary)
    | Gemini 2.5 Flash Lite (fallback)
    | Gemini 1.5 Flash (fallback)
```

The frontend never calls Gemini directly. All API keys stay server-side. Express handles retries, model fallbacks, and JSON repair for truncated responses.

---

## API Routes

| Route | What it does |
|-------|-------------|
| `POST /api/snap/analyze` | Identify destination from photo, generate full guide |
| `POST /api/snap/refine` | Conversational update to itinerary (duration, style, audience) |
| `POST /api/snap/packlist` | Destination-specific packing list + pre-trip checklist |
| `POST /api/tripsync/plan` | 3 group packages with per-person happiness scores |

---

## SnapTrip Flow

1. Upload photo or paste image URL
2. Gemini identifies destination - Call 1 (overview, budget, visa, crowd calendar, tips) + Call 2 (itinerary)
3. Renders: destination banner, crowd calendar, budget tiers, visa, must-see/eat, itinerary, local guide
4. Refine chat: "make it 5 days" or "travelling with kids" - AI returns updated itinerary, live cards update

## TripSync Flow

1. User clicks "Start Group Planning" from SnapTrip results
2. Step 1: Add travellers - name, travel vibe (multi-select), budget
3. Step 2: Group departure + return dates
4. AI receives the curated SnapTrip itinerary as context
5. Step 3: 3 packages generated, each with per-person happiness scores
6. Packing list and shareable trip card appear after packages

---

## Key Technical Decisions

**Split Gemini calls** - SnapTrip uses 2 calls (overview + itinerary). TripSync uses 1 focused call. Splitting prevents truncation from exceeding the 8192 token output limit.

**Plain English prompts** - No JSON schema templates embedded in prompts. Earlier versions embedded full JSON examples which consumed token budget and caused consistent truncation.

**String concatenation for prompts** - Template literals with backticks caused `SyntaxError` when nested. `+` concatenation is reliable across all Node versions.

**Retry + fallback** - `callGemini()` tries 3 models with exponential backoff (3s, 6s, 9s). Specifically detects "high demand" and "overloaded" responses and retries rather than failing.

**JSON repair** - `safeParseJSON()` closes open brackets/strings before throwing, recovering partially truncated responses.

---

## Environment Variables

```bash
GEMINI_API_KEY=AIza...    # Required
PORT=3000                  # Optional, default 3000
```

---

## Git Setup

```bash
git init
git add .
git commit -m "feat: SnapTrip + TripSync initial release"

# Push to GitHub
git remote add origin https://github.com/yourusername/snaptrip.git
git push -u origin main
```

The `.gitignore` already excludes `node_modules/` and `.env`. Never commit your API key.

---

## Deployment (Vercel)

```bash
npm i -g vercel
vercel --prod
```

Set `GEMINI_API_KEY` in Vercel Dashboard > Project > Settings > Environment Variables.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `npm install` EPERM error | Move out of Downloads: `cp -r ~/Downloads/snaptrip ~/snaptrip && cd ~/snaptrip` |
| Port 3000 in use | Add `PORT=3001` to `.env` |
| Image upload not working | Hard refresh Cmd+Shift+R. File input needs direct user gesture |
| TripSync truncated | Check terminal logs for prompt/response length. Wait 15s and retry if rate limited |
| `SyntaxError` on start | Check server.js for Unicode em dashes (U+2014) - replace with hyphens |
| Blank result | Open browser DevTools > Network, check the API response body for error details |
