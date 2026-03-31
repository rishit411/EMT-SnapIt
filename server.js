require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const fetch   = require('node-fetch');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Primary and fallback models - verified against your API key
const MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
];

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
}

// Retry with exponential backoff + model fallback
async function callGemini(body, retries = 3) {
  let lastErr;

  for (const model of MODELS) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(geminiUrl(model), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        // Rate limit / overload - wait and retry same model
        if (res.status === 429 || res.status === 503 ||
            (data.error?.message || '').toLowerCase().includes('high demand') ||
            (data.error?.message || '').toLowerCase().includes('overloaded')) {
          const wait = (attempt + 1) * 3000; // 3s, 6s, 9s
          console.log(`[${model}] Rate limited, retrying in ${wait/1000}s… (attempt ${attempt+1})`);
          await new Promise(r => setTimeout(r, wait));
          lastErr = new Error(data.error?.message || 'Rate limited');
          continue;
        }

        if (!res.ok) throw new Error(data.error?.message || `Gemini API error (${res.status})`);

        const candidate = data.candidates?.[0];
        const finishReason = candidate?.finishReason;
        const text = candidate?.content?.parts?.[0]?.text || '';
        if (!text) throw new Error('Empty response from Gemini');
        // MAX_TOKENS means the model ran out of budget mid-response — JSON will be broken
        if (finishReason === 'MAX_TOKENS') {
          console.log(`[${model}] MAX_TOKENS on attempt ${attempt+1}, retrying with next model…`);
          lastErr = new Error('MAX_TOKENS: response was cut off');
          break; // skip remaining attempts on this model, try next
        }
        if (model !== MODELS[0]) console.log(`[fallback] Succeeded with ${model}`);
        return text.replace(/```json|```/g, '').trim();

      } catch (err) {
        lastErr = err;
        if (attempt < retries - 1) {
          const wait = (attempt + 1) * 2000;
          console.log(`[${model}] Error: ${err.message} - retrying in ${wait/1000}s…`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }
    console.log(`[${model}] All retries failed, trying next model…`);
  }

  throw new Error('Gemini is busy right now. Please wait 10-15 seconds and try again.');
}

// ── JSON repair helper ────────────────────────────────────────────────────────
// Uses a nesting stack so closers are added in correct reverse order.
// e.g. truncated {"packages":[{"memberFit":[{"name": gets closed as "}]}]}"
// The old bracket-count approach produced "]]}}}" which is always wrong.
function safeParseJSON(raw) {
  const clean = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (_) {
    let fixed = clean.replace(/,\s*([\]}])/g, '$1').replace(/,\s*$/, '');

    // Walk the string tracking nesting and string state
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = 0; i < fixed.length; i++) {
      const ch = fixed[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }

    // Close any open string, strip trailing comma, close brackets in order
    if (inString) fixed += '"';
    fixed = fixed.replace(/,\s*$/, '');
    while (stack.length) fixed += stack.pop();

    try { return JSON.parse(fixed); }
    catch (e) { throw new Error('AI response truncated. Please try again.'); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: SnapTrip - split into 2 Gemini calls to avoid token limit
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/snap/analyze', upload.single('image'), async (req, res) => {
  try {
    let parts;
    if (req.file) {
      parts = [
        { inline_data: { mime_type: req.file.mimetype, data: req.file.buffer.toString('base64') } }
      ];
    } else if (req.body.imageUrl) {
      parts = [];
    } else {
      return res.status(400).json({ error: 'No image or URL provided' });
    }

    const imageUrl = req.body.imageUrl || null;
    const imgPrefix = imageUrl ? `Image URL: ${imageUrl}\n\n` : '';

    // ── CALL 1: Destination overview, budget, visa, crowd calendar ──────────
    const prompt1 = `${imgPrefix}You are a travel expert for EaseMyTrip India. Analyze this travel photo. Return ONLY valid JSON, no markdown, no backticks. Keep all string values under 120 chars.

{"destination":"City, Country","confidence":92,"country":"Country","isInternational":true,"region":"Specific region - 1 vivid sentence","tagline":"One magnetic sentence about this place","weather":"e.g. 22°C sunny","vibeKeywords":["vibe1","vibe2","vibe3"],"bestSeason":{"peak":"Mon-Mon","peakNote":"Why peak is great","offPeak":"Mon-Mon","offPeakNote":"Why off-peak is smart","avoid":"Mon-Mon","avoidNote":"Why avoid"},"crowdCalendar":[{"month":"Jan","level":"low"},{"month":"Feb","level":"low"},{"month":"Mar","level":"medium"},{"month":"Apr","level":"medium"},{"month":"May","level":"high"},{"month":"Jun","level":"high"},{"month":"Jul","level":"peak"},{"month":"Aug","level":"peak"},{"month":"Sep","level":"high"},{"month":"Oct","level":"medium"},{"month":"Nov","level":"low"},{"month":"Dec","level":"low"}],"budgetBreakdown":{"flightRoundTrip":"₹X-₹Y from Delhi","accommodation":"₹X-₹Y/night","dailyExpenses":"₹X-₹Y/day","totalEstimate":{"budget":"₹X for 7 days","midRange":"₹X for 7 days","luxury":"₹X+ for 7 days"},"bestDealTip":"Specific money-saving tip"},"visa":{"required":true,"type":"Visa type","processingTime":"X working days","fee":"Fee amount","validity":"Validity period","documents":["Doc 1","Doc 2","Doc 3","Doc 4","Doc 5"],"applyAt":"Where to apply","proTip":"Specific visa pro tip"},"mustSee":[{"name":"Place 1","why":"Why unmissable","bestTime":"When"},{"name":"Place 2","why":"Why","bestTime":"When"},{"name":"Place 3","why":"Why","bestTime":"When"},{"name":"Place 4","why":"Why","bestTime":"When"}],"mustEat":[{"dish":"Dish 1","where":"Restaurant/area","price":"₹XXX","note":"Why special"},{"dish":"Dish 2","where":"Where","price":"₹XXX","note":"Note"},{"dish":"Dish 3","where":"Where","price":"₹XXX","note":"Note"}],"localGuide":{"gettingAround":"Transport options and apps","localCurrency":"Currency and exchange tips","language":"Language and key phrases","customs":"Local etiquette","safety":"Safety tips","sim":"Best SIM card option","apps":["App 1 - purpose","App 2 - purpose","App 3 - purpose"]},"insiderTips":[{"icon":"🕐","title":"Beat the crowds","tip":"Specific timing advice"},{"icon":"💰","title":"Save money","tip":"Specific saving hack"},{"icon":"🎒","title":"What to pack","tip":"Specific packing tip"},{"icon":"⚠️","title":"Common mistake","tip":"What tourists regret"}],"suggestedAlternatives":[{"name":"Alt 1","country":"Country","why":"Why similar/different","budgetVs":"Cheaper/pricier by X","vibe":"Vibe words","isInternational":true},{"name":"Alt 2","country":"Country","why":"Why","budgetVs":"Budget comparison","vibe":"Vibe","isInternational":false},{"name":"Alt 3","country":"Country","why":"Why","budgetVs":"Budget comparison","vibe":"Vibe","isInternational":true}]}

Replace ALL placeholders with real specific content for the destination in the photo. Level options: low/medium/high/peak.`;

    const call1Parts = imageUrl
      ? [{ text: prompt1 }]
      : [...parts, { text: prompt1 }];

    const raw1 = await callGemini({
      contents: [{ role: 'user', parts: call1Parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
    });

    let result1 = safeParseJSON(raw1);

    // ── CALL 2: 3-day itinerary ──────────────────────────────────────────────
    const dest = result1.destination || 'this destination';
    const prompt2 = `You are a travel curator for EaseMyTrip India. Create a detailed 3-day itinerary for ${dest}. Return ONLY valid JSON, no markdown, no backticks. Keep descriptions under 150 chars each.

{"itinerary":[{"day":1,"title":"Day 1 evocative title","theme":"One sentence about this day","activities":[{"time":"09:00","title":"Activity name","desc":"Specific description with real place name and what makes it special.","type":"sightseeing","duration":"2 hrs","cost":"₹XXX"},{"time":"12:30","title":"Lunch spot","desc":"Specific restaurant and what to order.","type":"food","duration":"1 hr","cost":"₹XXX"},{"time":"15:00","title":"Afternoon activity","desc":"Specific description.","type":"adventure","duration":"2 hrs","cost":"₹XXX"},{"time":"19:30","title":"Evening","desc":"Specific atmosphere and dinner recommendation.","type":"dining","duration":"2 hrs","cost":"₹XXX"}]},{"day":2,"title":"Day 2 title","theme":"Day 2 theme","activities":[{"time":"07:30","title":"Sunrise activity","desc":"Specific description.","type":"nature","duration":"1.5 hrs","cost":"Free"},{"time":"10:00","title":"Morning activity","desc":"Specific description.","type":"sightseeing","duration":"2 hrs","cost":"₹XXX"},{"time":"13:30","title":"Lunch","desc":"Specific recommendation.","type":"food","duration":"1 hr","cost":"₹XXX"},{"time":"16:00","title":"Afternoon","desc":"Specific description.","type":"culture","duration":"2 hrs","cost":"₹XXX"},{"time":"20:00","title":"Evening","desc":"Specific scene and dinner.","type":"dining","duration":"2 hrs","cost":"₹XXX"}]},{"day":3,"title":"Day 3 title","theme":"Day 3 theme","activities":[{"time":"08:00","title":"Morning","desc":"Specific description.","type":"adventure","duration":"2 hrs","cost":"₹XXX"},{"time":"11:00","title":"Late morning","desc":"Specific description.","type":"sightseeing","duration":"2 hrs","cost":"₹XXX"},{"time":"14:00","title":"Lunch","desc":"Specific recommendation.","type":"food","duration":"1 hr","cost":"₹XXX"},{"time":"16:30","title":"Afternoon","desc":"Specific description.","type":"nature","duration":"2 hrs","cost":"Free"},{"time":"20:00","title":"Final evening","desc":"Memorable send-off dinner at a specific venue.","type":"dining","duration":"2 hrs","cost":"₹XXX"}]}]}

Fill every desc with real specific content for ${dest}. Activity types: sightseeing/food/adventure/culture/nature/dining.`;

    const call2Parts = imageUrl
      ? [{ text: prompt2 }]
      : [...parts, { text: prompt2 }];

    const raw2 = await callGemini({
      contents: [{ role: 'user', parts: call2Parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
    });

    const result2 = safeParseJSON(raw2);

    // Merge both results
    const final = { ...result1, ...(result2 || {}) };
    res.json(final);

  } catch (err) {
    console.error('Snap analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2: TripSync - split into 2 Gemini calls to avoid truncation
// Call 1: group insight + 3 packages (costs, highlights, memberFit)
// Call 2: day plans for all 3 packages
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/tripsync/plan', async (req, res) => {
  try {
    const { destination, travellers, members, startDate, endDate, curatedItinerary, snapContext } = req.body;

    const nights = startDate && endDate
      ? Math.round((new Date(endDate) - new Date(startDate)) / (1000*60*60*24)) : 5;
    const dest0  = (destination||'').split(',')[0].trim();
    const m      = members || [];
    const n      = m.length || parseInt(travellers) || 1;

    // Budget range
    const rankMap = {'Rs20K-Rs50K':0,'Rs50K-Rs1L':1,'Rs1L-Rs2L':2,'Rs2L+':3,'20K-50K':0,'50K-1L':1,'1L-2L':2};
    const bvals   = m.map(p=>p.budget).filter(Boolean);
    const sorted  = [...bvals].sort((a,b)=>{
      const ai = Object.keys(rankMap).findIndex(k=>a.includes(k.replace('Rs','')))||0;
      const bi = Object.keys(rankMap).findIndex(k=>b.includes(k.replace('Rs','')))||0;
      return ai-bi;
    });
    const bMin = sorted[0] || 'mid-range';
    const bMax = sorted[sorted.length-1] || bMin;

    // Per-person profiles
    const profiles = m.map(p => {
      const vibes = [...new Set([...(p.vibes||[]), ...(p.interests||[])])].slice(0,3).join(', ') || 'general';
      let line = p.name + ': budget ' + (p.budget||'flexible') + ', loves ' + vibes;
      if (p.mustHave)    line += ', must-have: ' + p.mustHave;
      if (p.dealBreaker) line += ', avoid: ' + p.dealBreaker;
      return line;
    }).join(' | ');

    const names = m.map(p=>p.name).join(', ');

    // Summarise the curated itinerary from SnapTrip
    const itinSummary = (curatedItinerary||[]).slice(0,3).map(d =>
      'Day ' + d.day + ' (' + d.title + '): ' + (d.activities||[]).join(', ')
    ).join('; ');

    const context = snapContext || {};
    const vibe = (context.vibeKeywords||[]).join(', ') || '';

    const baseContext = 'Destination: ' + destination + ' (' + nights + ' nights). '
      + (itinSummary ? 'Curated itinerary: ' + itinSummary + '. ' : '')
      + (vibe ? 'Destination vibe: ' + vibe + '. ' : '')
      + 'Group: ' + n + ' people. Members: ' + profiles + '. '
      + 'Budget range: ' + bMin + ' to ' + bMax + '. ';

    // ── CALL 1: packages with memberFit (no dayPlan) ────────────────────────
    const prompt1 = 'You are a personalised group travel planner for EaseMyTrip India. '
      + baseContext
      + 'Create 3 package OPTIONS (budget / mid-range / premium splurge) tailored to the destination and each persons preferences. '
      + 'For EACH package give: name, tagline, type, totalCostPerPerson, totalGroupCost (for ' + n + ' people), '
      + '3 highlights, real hotel name + area + price/night, groupPerks, bestFor, '
      + 'and for EACH of [' + names + ']: happiness score 60-95 + what they specifically love + what they compromise. '
      + 'Also give groupInsight and groupTip at the top level. '
      + 'Respond ONLY with valid JSON. No markdown. Keep all strings under 80 chars. '
      + 'JSON: {"groupInsight":"str","groupTip":"str","packages":['
      + '{"id":1,"name":"str","tagline":"str","type":"str","totalCostPerPerson":"str","totalGroupCost":"str",'
      + '"highlights":["str","str","str"],"accommodation":{"name":"str","area":"str","pricePerNight":"str"},'
      + '"groupPerks":"str","bestFor":"str",'
      + '"memberFit":[{"name":"str","score":80,"loves":"str","compromise":"str"}]}]}';

    console.log('[TripSync] Call 1 prompt:', prompt1.length, 'chars, members:', n, ', nights:', nights);

    const raw1 = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt1 }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
    });

    console.log('[TripSync] Call 1 response:', raw1.length, 'chars');
    const result1 = safeParseJSON(raw1);

    // ── CALL 2: day plans for all 3 packages ────────────────────────────────
    const packageNames = (result1.packages || []).map(p => p.id + ':' + p.name).join(', ');

    const prompt2 = 'You are a group travel day planner for EaseMyTrip India. '
      + baseContext
      + 'You have 3 packages: ' + packageNames + '. '
      + 'For each package, generate a Day 1 activity plan with 4 real activities. '
      + 'Activities must match the package type (budget vs premium) and destination. '
      + 'Respond ONLY with valid JSON. No markdown. Keep all strings under 80 chars. '
      + 'JSON: {"dayPlans":['
      + '{"packageId":1,"activities":[{"time":"09:00","activity":"str","cost":"str","type":"sightseeing"},'
      + '{"time":"12:00","activity":"str","cost":"str","type":"food"},'
      + '{"time":"15:00","activity":"str","cost":"str","type":"sightseeing"},'
      + '{"time":"19:30","activity":"str","cost":"str","type":"dining"}]}]}';

    console.log('[TripSync] Call 2 prompt:', prompt2.length, 'chars');

    const raw2 = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt2 }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 }
    });

    console.log('[TripSync] Call 2 response:', raw2.length, 'chars');
    const result2 = safeParseJSON(raw2);

    // Merge dayPlans into packages
    const dayPlansMap = {};
    (result2.dayPlans || []).forEach(dp => { dayPlansMap[dp.packageId] = dp.activities; });

    const merged = {
      ...result1,
      packages: (result1.packages || []).map(pkg => ({
        ...pkg,
        dayPlan: dayPlansMap[pkg.id]
          ? [{ day: 1, title: 'Day 1', activities: dayPlansMap[pkg.id] }]
          : []
      }))
    };

    res.json(merged);

  } catch(err) {
    console.error('TripSync plan error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/snap/refine', async (req, res) => {
  try {
    const { question, currentData } = req.body;
    if (!question || !currentData) return res.status(400).json({ error: 'Missing question or data' });

    const dest    = currentData.destination || 'this destination';
    const curDays = (currentData.itinerary || []).length || 3;
    const curBudget = currentData.budgetBreakdown?.totalEstimate?.midRange || 'mid-range';

    const prompt = 'You are a travel expert for EaseMyTrip India. '
      + 'A user has a trip planned to ' + dest + ' (' + curDays + ' days, budget: ' + curBudget + '). '
      + 'They asked: "' + question + '". '
      + 'Figure out what they want to change: duration, budget, travel style, who is travelling, season, or activities. '
      + 'Return ONLY a JSON object with these fields: '
      + '{ '
      + '"answer": "2-3 sentence helpful response addressing their question", '
      + '"actionType": "one of: updateDuration|updateBudget|updateStyle|updateSeason|info", '
      + '"updatedDays": <number of days if they want a duration change, else ' + curDays + '>, '
      + '"updatedStyle": "family|romantic|adventure|cultural|wellness|budget|luxury or null", '
      + '"updatedSeason": "specific months if they ask about timing, else null", '
      + '"updatedItinerary": [array of day objects if itinerary changes are needed, else null - each day: {"day":N,"title":"string","theme":"string","activities":[{"time":"HH:MM","title":"string","desc":"string","type":"string","duration":"string","cost":"string"}]}], '
      + '"suggestions": ["follow-up question 1", "follow-up question 2", "follow-up question 3"], '
      + '"updatedTip": "one specific insider tip relevant to their question" '
      + '}. '
      + 'If they ask for more days (e.g. 5 days), set updatedDays to 5 and provide updatedItinerary with that many days. '
      + 'If they ask for budget version, set updatedBudget fields. '
      + 'Keep all strings under 120 chars. No markdown. Only JSON.';

    const raw = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4000 }
    });
    res.json(safeParseJSON(raw));
  } catch (err) {
    console.error('Refine error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 4: Packing list + pre-trip checklist
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/snap/packlist', async (req, res) => {
  try {
    const { destination, travelDates, isInternational, weather, tripStyle } = req.body;
    if (!destination) return res.status(400).json({ error: 'Missing destination' });

    const prompt = `Travel packing expert for EaseMyTrip India. Create a personalised packing list and pre-trip checklist for ${destination}.

Context: ${isInternational ? 'International trip' : 'Domestic trip'}, weather: ${weather || 'moderate'}, travel style: ${tripStyle || 'balanced'}, dates: ${travelDates || 'flexible'}.

Return ONLY valid JSON:
{
  "packingList": {
    "essentials": ["Item 1", "Item 2", "Item 3", "Item 4", "Item 5"],
    "clothing": ["Item 1", "Item 2", "Item 3", "Item 4"],
    "tech": ["Item 1", "Item 2", "Item 3"],
    "toiletries": ["Item 1", "Item 2", "Item 3"],
    "destinationSpecific": ["Specific item for ${destination} 1", "Specific item 2", "Specific item 3"]
  },
  "preTripChecklist": [
    {"task": "Book flights", "daysBeforeTravel": 60, "done": false},
    {"task": "Apply for visa", "daysBeforeTravel": 45, "done": false},
    {"task": "Book accommodation", "daysBeforeTravel": 30, "done": false},
    {"task": "Get travel insurance", "daysBeforeTravel": 30, "done": false},
    {"task": "Exchange currency", "daysBeforeTravel": 7, "done": false},
    {"task": "Download offline maps", "daysBeforeTravel": 3, "done": false},
    {"task": "Notify bank of travel", "daysBeforeTravel": 7, "done": false},
    {"task": "Check passport validity", "daysBeforeTravel": 90, "done": false}
  ],
  "destinationTip": "One specific packing tip most people forget for ${destination}"
}

Make packingList items specific to ${destination}'s conditions. Keep each item under 40 chars.`;

    const raw = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2000 }
    });
    res.json(safeParseJSON(raw));
  } catch (err) {
    console.error('Packlist error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅  SnapTrip + TripSync running at http://localhost:${PORT}\n`);
});
