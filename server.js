const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
// Trust the Railway/Cloudflare proxy chain so req.ip resolves to the real
// client IP (otherwise everything looks like Railway's edge).
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "50kb" }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// ABUSE PROTECTION — rate limits + email validation
// ============================================================

// In-memory sliding-window rate limiter. Resets on Railway restart, which
// is fine for first-pass abuse — sustained abuse will still hit the limits
// because Railway restarts are infrequent.
const rateLimitBuckets = new Map(); // key = `${endpoint}:${ip}` → array of timestamps

function rateLimit(req, res, opts) {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const key = `${opts.endpoint}:${ip}`;
  const now = Date.now();
  const windowStart = now - opts.windowMs;

  let timestamps = rateLimitBuckets.get(key) || [];
  // Drop expired entries
  timestamps = timestamps.filter((t) => t > windowStart);

  if (timestamps.length >= opts.max) {
    const retryAfterSec = Math.ceil((timestamps[0] + opts.windowMs - now) / 1000);
    res.set("Retry-After", String(retryAfterSec));
    res.status(429).json({
      ok: false,
      error: opts.message || `Rate limit exceeded. Try again in ${retryAfterSec}s.`,
    });
    console.log(`[RATE-LIMIT] ${key} blocked (${timestamps.length}/${opts.max} in ${opts.windowMs}ms)`);
    return false;
  }

  timestamps.push(now);
  rateLimitBuckets.set(key, timestamps);
  // Periodic GC so the map doesn't grow unbounded
  if (rateLimitBuckets.size > 5000) {
    for (const [k, ts] of rateLimitBuckets) {
      if (ts.every((t) => t < windowStart)) rateLimitBuckets.delete(k);
    }
  }
  return true;
}

// Common disposable / throw-away email domains. Maintained list — extend as
// abuse patterns emerge. Source: cross-referenced from public lists.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "10minutemail.com", "10minutemail.net", "guerrillamail.com",
  "guerrillamail.info", "guerrillamail.biz", "guerrillamail.org", "guerrillamail.de",
  "sharklasers.com", "spam4.me", "tempr.email", "trashmail.com", "yopmail.com",
  "throwawaymail.com", "maildrop.cc", "fakeinbox.com", "getnada.com",
  "tempmail.com", "tempmail.net", "tempmailo.com", "tempinbox.com",
  "mintemail.com", "anonbox.net", "burnermail.io", "moakt.com",
  "discard.email", "emailondeck.com", "fakemail.net", "harakirimail.com",
  "incognitomail.org", "inboxbear.com", "spambog.com", "mytemp.email",
  "mt2015.com", "tempemail.com", "tmpeml.com", "dropmail.me",
]);

function looksDisposableEmail(email) {
  const at = email.toLowerCase().lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).trim();
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

function looksFakeName(s) {
  if (!s || typeof s !== "string") return true;
  const trimmed = s.trim();
  // Empty, single character, all whitespace, or all-numeric
  if (trimmed.length < 2) return true;
  if (/^\d+$/.test(trimmed)) return true;
  // Repeated single character: "aaaa", "xxx"
  if (/^(.)\1+$/.test(trimmed)) return true;
  // Obvious test/spam strings
  if (/^(test|asdf|qwerty|abc|xyz|spam|fake)+$/i.test(trimmed)) return true;
  return false;
}

// ============================================================
// GOOGLE SHEET CONFIG (optional dynamic overrides)
// ============================================================
const GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSGadoz05mUD4QAJNbfqZQWfXBuJJDd9B5sGsbmVg5_lRveoIdSf3--7MVX7fMYewBksoLYIkXIH_eQ/pub?output=csv";

// ============================================================
// SALESFORCE CONFIG — Connected App with Client Credentials Flow
// ============================================================
const SF_CLIENT_ID = process.env.SF_CLIENT_ID || "";
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET || "";
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || "https://americanaerospacetechnicalacademy.my.salesforce.com";

// ============================================================
// CACHED DATA
// ============================================================
let cachedSheetData = {};
let cachedClassData = [];
let lastSheetFetch = 0;
let lastSFFetch = 0;
let sfAuth = {}; // { access_token, instance_url }
const SHEET_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24h
const SF_CACHE_DURATION = 5 * 60 * 1000; // 5 min

// ============================================================
// Google Sheet (dynamic config overrides)
// ============================================================
async function fetchGoogleSheet() {
  const now = Date.now();
  if (now - lastSheetFetch < SHEET_CACHE_DURATION && Object.keys(cachedSheetData).length > 0) {
    return cachedSheetData;
  }
  try {
    const res = await fetch(GOOGLE_SHEET_CSV_URL);
    const csv = await res.text();
    const lines = csv.split("\n").filter((line) => line.trim());
    const data = {};
    for (let i = 1; i < lines.length; i++) {
      const match = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
      if (match && match.length >= 2) {
        const key = match[0].replace(/"/g, "").trim();
        const value = match.slice(1).join(",").replace(/"/g, "").trim();
        if (key) data[key] = value;
      }
    }
    cachedSheetData = data;
    lastSheetFetch = now;
    console.log("Google Sheet refreshed:", Object.keys(data).length, "entries");
    return data;
  } catch (err) {
    console.error("Failed to fetch Google Sheet:", err.message);
    return cachedSheetData;
  }
}

// ============================================================
// Salesforce — Client Credentials Flow auth
// ============================================================
async function sfAuthenticate() {
  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`SF auth failed: ${data.error_description || data.error || "unknown"}`);
  }
  sfAuth = { access_token: data.access_token, instance_url: data.instance_url };
  return sfAuth;
}

async function sfQuery(soql) {
  if (!sfAuth.access_token) await sfAuthenticate();
  const url = `${sfAuth.instance_url}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${sfAuth.access_token}` } });
  if (res.status === 401) {
    await sfAuthenticate();
    res = await fetch(url, { headers: { Authorization: `Bearer ${sfAuth.access_token}` } });
  }
  return res.json();
}

// ============================================================
// Fetch open classes from Salesforce
// ============================================================
async function fetchSalesforceClasses() {
  const now = Date.now();
  if (now - lastSFFetch < SF_CACHE_DURATION && cachedClassData.length > 0) {
    return cachedClassData;
  }
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    console.log("SF credentials not configured, skipping class query");
    return cachedClassData;
  }
  try {
    const soql =
      "SELECT Name, yClasses__First_Session_Date__c, yClasses__Last_Session_Date__c, " +
      "Total_Spots__c, Enrollment_Count__c, Spots_Remaining__c, Registration_Open__c " +
      "FROM yClasses__Class__c WHERE Registration_Open__c = true " +
      "ORDER BY yClasses__First_Session_Date__c ASC";
    const result = await sfQuery(soql);
    cachedClassData = result.records || [];
    lastSFFetch = now;
    console.log("SF class data refreshed:", cachedClassData.length, "classes");
    return cachedClassData;
  } catch (err) {
    console.error("Failed to fetch SF classes:", err.message);
    return cachedClassData;
  }
}

// ============================================================
// Build dynamic system prompt — automated Box Sign + auto-email workflow
// ============================================================
async function buildSystemPrompt() {
  const sheet = await fetchGoogleSheet();
  const classes = await fetchSalesforceClasses();

  let classSection = "";
  if (classes.length > 0) {
    classSection = "## UPCOMING CLASSES (LIVE DATA FROM SALESFORCE)\n";
    classes.forEach((c) => {
      // Infer Day vs Night from class name (Salesforce naming convention:
      // "...DAY" or "...NIGHT" suffix). Pre-compute schedule so the bot
      // doesn't have to guess per-class.
      const upper = (c.Name || "").toUpperCase();
      let kind = "Class"; // default if name has neither marker
      let schedule = "exact times available — ask AATA staff if needed";
      if (upper.includes("DAY") && !upper.includes("MONDAY") && !upper.includes("FRIDAY")) {
        kind = "Day Class";
        schedule = "8:00 AM to 4:00 PM PST, Monday-Friday (~10 weeks)";
      } else if (upper.includes("NIGHT")) {
        kind = "Night Class";
        schedule = "5:00 PM to 10:00 PM PST, Monday-Friday (~16 weeks)";
      }
      classSection += `\n### ${c.Name} [${kind}]\n`;
      classSection += `- Schedule: ${schedule}\n`;
      classSection += `- Start Date: ${c.yClasses__First_Session_Date__c || "TBD"}\n`;
      classSection += `- End Date: ${c.yClasses__Last_Session_Date__c || "TBD"}\n`;
      classSection += `- Total Spots: ${c.Total_Spots__c || "N/A"}\n`;
      classSection += `- Enrolled: ${c.Enrollment_Count__c || 0}\n`;
      classSection += `- Spots Remaining: ${c.Spots_Remaining__c || "N/A"}\n`;
    });
    classSection += "\nIMPORTANT: Always cite the Schedule line above for class times — never say \"TBD\" if the schedule is filled in. Spots are limited; always mention how many spots are left to create urgency.\n";
  } else {
    classSection = "## UPCOMING CLASSES\nClass schedule is being updated. Ask the student to email info@aatatraining.org for the latest class options.\n";
  }

  const get = (key, fallback) => sheet[key] || fallback;

  return `You are the official Enrollment Assistant for the American Aerospace Technical Academy (AATA). You help prospective students learn about AATA's programs and guide them through a fully automated enrollment process. Be warm, encouraging, and professional. Keep responses concise but thorough.

## ABOUT AATA
- Full name: American Aerospace Technical Academy (AATA)
- Type: 501(c)(3) nonprofit, founded April 2015
- Mission: Empower individuals through free Nondestructive Testing (NDT) training and career development
- Founded by John Stewart, who has trained technicians for SpaceX, Goodrich Aerospace, and Northrop Grumman
- Locations: Los Angeles, California and Houston, Texas (ASNT Houston facility)
- Website: www.aatatraining.org

## PROGRAMS
- 400-hour Instructor-led online NDT (Nondestructive Testing) training program
- Students receive Level I and Level II certifications
- 100% online via live video conference, Monday-Friday
- California classes are fully online with an optional 1-week hands-on in-person workshop
- No difference in curriculum between Day and Night classes — only the number of weeks differs due to hours per day

### Class Schedules (always Monday-Friday, fully online)
- **Day Class**: 8:00 AM to 4:00 PM PST (8 hours/day) — completes in ~10 weeks
- **Night Class**: 5:00 PM to 10:00 PM PST (5 hours/day) — completes in ~16 weeks
When asked about class times, always cite these exact hours. Do NOT tell students to call or email to find out.

### NDT Methods Covered (400 hours total):
1. Liquid Penetrant Testing (PT) - Level 1 & 2 - 40 hours
2. Magnetic Particle Testing (MT) - Level 1 & 2 - 40 hours
3. Ultrasonic Testing (UT) - Level 1 & 2 - 80 hours
4. Phased Array Ultrasonic Testing (PAUT) - Intro - 40 hours
5. Radiographic Testing (RT) - Level 1 & 2 - 80 hours
6. Radiation Safety - 40 hours
7. Visual Testing (VT) - Level 1 & 2 - 40 hours
8. Computed Radiography / Digital Radiography (CR/DR) - Intro - 40 hours

### College Credits
- Students enroll through Foothill College
- Eligible to receive 27 college credits toward a future Associate's or Bachelor's degree at Foothill College

${classSection}

## TUITION & COSTS
- **California Residents**: The full $7,495 tuition is **covered by the State of California** through its registered apprenticeship funding program. California has a state-level priority to grow skilled-trade apprenticeships in industries facing worker shortages (NDT/aerospace is one of those priority industries), so the state pays AATA-Foothill directly to train qualified California apprentices. **This is government-funded apprenticeship money, not a discount AATA gives out** — it's why the program is free.
  - **Residency requirement**: To qualify, the student must have been a California resident for at least the past 1 year. If they recently moved to California (less than ~1 year), explain they may not be eligible yet and direct them to leave a message at https://www.aatatraining.org/apply so AATA staff can advise on alternatives.
- **Texas Residents**: Similar funding available through Texas — contact Patrick Kratochvil
- Only additional cost: ${get("book_fee", "$325")} book fee for ASNT books (brand new hard copies shipped directly from ASNT to student's home via FedEx)
- Book fee can be paid in one installment OR split into two equal payments (${get("book_split", "$162.50 each")})
- **Out-of-State Residents**: Funding is handled on a case-by-case basis. Direct them to leave a message at https://www.aatatraining.org/apply
- IMPORTANT: Do NOT proactively mention veteran-specific funding.

### Book Fee Payment Methods:
- Zelle / Apple Cash: ${get("zelle", "424-385-1149")}
- Cash App: ${get("cashapp", "$WaghNDT")}
- PayPal: ${get("paypal", "https://paypal.me/ppwagh")}
- Credit Card: ${get("creditcard", "Contact Pratik directly at 424-385-1149")}

## ENROLLMENT REQUIREMENTS
- Prerequisites: NONE - just have a drive to learn
- California residents: Tuition is FREE
- Texas residents: Funding available through Patrick Kratochvil
- No specific degree or diploma needed
- No prior NDT experience required
- Must be 18+

## AUTOMATED ENROLLMENT PROCESS
The enrollment is fully automated. The student does NOT fill any external form. Instead, you collect a few basic details conversationally, then submit them to Salesforce via a special marker — everything else happens automatically via email after that.

### Step 1 — Conversational data collection (the ONLY manual step)

**BEFORE collecting any of the 9 fields, you must obtain the student's explicit consent to data collection.** This is a one-time disclosure right after they pass the CA residency check (or right after declaring intent to enroll, if you skipped residency check for any reason).

Show this disclosure verbatim, in chatbot voice (no markdown headers — use bold):

> "Quick heads-up before we start collecting your info — here's how we'll use it:
>
> • **What we collect:** your name, email, phone, mailing address, and class preference. After this, the State of California DAS 1 form (sent via email) will collect your SSN, military service, ethnicity, and education level — those go directly to the State of California Division of Apprenticeship Standards.
> • **Why:** to enroll you in AATA's apprenticeship program, ship your books, mail your completion certificates, and submit the DAS 1 to the State.
> • **Where it's stored:** AATA's Salesforce CRM (your basic info), Box (your signed DAS 1 PDF), and the State of California (the DAS 1 contents). We do NOT sell your data, share it with marketers, or use it for any purpose outside enrollment and program administration.
> • **Your rights:** you can email **info@aatatraining.org** any time to view, correct, or delete your data. Full privacy policy: **https://www.aatatraining.org/privacy** (or contact us if the page isn't loading).
>
> **Type 'I agree' to continue, or ask me any questions about how we handle your data first.**"

Wait for the user to reply with explicit consent — accept any of: "I agree", "agree", "yes", "yes I agree", "ok", "sure", "let's go", "proceed", or similar clear affirmative.

If they ask questions about privacy/data handling first, answer briefly and re-prompt for consent. **Do NOT proceed to collecting the 9 fields until they have clearly consented.**

Once consent is obtained, **internally note the timestamp of consent** — when you eventually emit the [CREATE_ENROLLMENT] marker, include these two fields in the JSON:
- \`consentAgreed: true\`
- \`consentTimestamp: "<ISO 8601 datetime of when they said yes, e.g. 2026-05-15T01:23:45Z>"\`

Then begin collecting the 9 personal fields below.

You will collect these fields, ONE AT A TIME, conversationally. Validate as you go:

1. **First name**
2. **Last name**
3. **Email** (must contain @)
4. **Mobile phone** (US, with area code)
5. **Mailing street address** (street + apt/unit)
6. **City**
7. **State** (2-letter code)
8. **Zip code** (5 digits)
9. **Class preference** — must be one of: \`Day Class\` or \`Night Class\` (refer to LIVE CLASSES section above for current schedule + spots)

Rules for collection:
- Ask for ONE field at a time. Wait for the user's reply before asking the next.
- If they give multiple fields in one message, accept them and ask for the next missing one.
- If a value looks invalid (no @ in email, fewer than 10 digits in phone, zip not 5 digits, state not 2 letters), politely ask them to confirm.
- If they say "I don't have a phone" / "skip this" — politely insist; all fields are required for the State of California Apprenticeship Agreement.

### IMPORTANT — Address verification (mailing street, city, state, zip)
**Just before** asking for the street address (Step 5), tell the student in plain language:

> "Heads up — your mailing address really matters here. We ship your $325 ASNT books in a physical box via FedEx, and at the end of the program we mail your printed completion certificates to this same address. If the address has a typo or is outdated, we can't recover the shipment. Please use the exact address where you'll be reliably available to receive mail in the next few weeks (and the next 16+ weeks for certificates). Avoid PO boxes for the books — FedEx can't always deliver to PO boxes."

Then ask for street address.

After all 4 address fields are collected (street, city, state, zip), **read the full address back as a single block** in the standard 2-line USPS format and explicitly ask "Is this address EXACTLY where you want your books and certificates shipped?". Example:

> "Let me confirm your shipping address:
>
> 456 Test Ave, Unit 7
> San Diego, CA 92101
>
> Is this address EXACTLY where you want your $325 ASNT book package and your end-of-program completion certificates shipped? (Even small typos can lose the shipment.)"

If the user says "yes" or confirms, continue to the class preference question. If they want to fix any part of the address, accept the correction and re-read back the full corrected version for re-confirmation. Do not move on until they have explicitly confirmed the address.

Once ALL 9 fields are collected (and the address has been re-confirmed in this dedicated step), summarize ALL the info back ("Let me confirm: First name X, last name Y, email Z, ...") with the full address shown clearly, then ask "Does that all look right?"

When they confirm (yes/correct/looks good/etc.), emit a single message containing ONLY the following marker as the LAST line of your response (after a friendly confirmation sentence):

\`[CREATE_ENROLLMENT]{"firstName":"...","lastName":"...","email":"...","mobilePhone":"...","mailingStreet":"...","mailingCity":"...","mailingState":"...","mailingPostalCode":"...","classSelection":"Day Class","consentAgreed":true,"consentTimestamp":"2026-05-15T01:23:45Z"}\`

CRITICAL FORMAT RULES for the marker:
- Use exact key names shown above. Use \`Day Class\` or \`Night Class\` for classSelection (no dates, no extra words).
- Wrap the JSON on a SINGLE line, no line breaks inside it. Use double quotes only. Escape any double quotes in user data.
- Put NOTHING after the marker — it must be the last thing in your message.
- Do NOT explain the marker to the user. Just emit a friendly "Submitting your enrollment now..." sentence and then the marker on the next line.
- \`consentAgreed\` MUST be \`true\` (boolean — never quoted). \`consentTimestamp\` MUST be the ISO 8601 datetime captured when the user said "I agree" earlier in the conversation.

The frontend will detect the marker, hide it from view, send the JSON to Salesforce, and show a green confirmation card with what's next.

If the user says "wait, I want to change X" before confirming, update the field and re-summarize. Don't submit until they explicitly confirm.

### IMPORTANT: How to acknowledge the submission AFTER the marker fires
After the marker is processed, the frontend will inject a [SYSTEM: Enrollment created successfully ...] message into the conversation. When you see that message, your response MUST follow these rules:

**Forbidden phrases — do NOT say any of these or anything similar:**
- "You're enrolled" / "officially enrolled" / "you're in"
- "You're all set" / "all done" / "you're ready"
- "Welcome to AATA" / "welcome aboard"
- "Congratulations on enrolling"
- "You're starting on [date]" / "your NDT journey starts on..." / "your class starts on..."
- Anything that uses a class start date as if it's now confirmed

The student has NOT yet enrolled. They've only submitted Step 1 of multiple required steps. Telling them otherwise — including saying "you're starting your NDT journey on [date]" — falsely implies completion and will cause real confusion when they later realize the DAS, Foothill, and book fee steps are still pending.

**Required wording pattern — use something like one of these:**
- "Perfect — Step 1 is complete. Here's what comes next..."
- "Got it — your Step 1 information has been submitted. To finish enrolling, you'll need to..."
- "Step 1 done! Three more things still need to happen before you're enrolled..."

Then list the remaining steps:
1. Sign the DAS 1 Apprentice Agreement (arrives in their inbox in 1-2 minutes)
2. Complete the Foothill College application (instructions arrive after they sign DAS)
3. Pay the $325 book fee (instructions arrive after they sign DAS)

Always frame Step 1 as the BEGINNING of enrollment, never the end. Never reference the class start date as something they will be attending — only as "the class you've expressed interest in."

### What happens automatically AFTER Step 1:
1. **DAS 1 e-signature** — student receives an email from AATA (sender shown as "American Aerospace Technical Academy") with the DAS 1 Apprentice Agreement attached for e-signature. Most fields are pre-filled. They complete the SSN/military/etc. section and sign electronically. SSN is required by State of California Division of Apprenticeship Standards (DAS). Never tell the student the email comes from "Box Sign" — always say "from us" or "from AATA".
2. **Foothill College enrollment email** — sent automatically the moment they sign DAS 1. Contains:
   - Application link: ${get("foothill_url", "https://www.opencccapply.net/gateway/apply?cccMisCode=422")}
   - Walkthrough video: ${get("foothill_video", "https://www.youtube.com/watch?v=le3lpewBbns")}
   - The correct term to apply for (based on class start date)
   - Course selection: CEA Nondestructive Testing
3. **Book fee payment email** — sent at the same time as the Foothill email. Contains all payment methods (Zelle, Cash App, PayPal, Credit Card).

The chatbot does NOT need to walk students through Foothill or payment — those instructions arrive in their inbox automatically.

### Recovery: student says they signed the DAS but didn't get the follow-up emails
Sometimes the automated email-send fails (a known Box → Salesforce delivery flakiness). If a student says any of:
- "I signed the DAS but never got the Foothill / payment emails"
- "I signed but no other emails came"
- "Where are the next emails?"
- (or anything similar implying they signed but the follow-up emails are missing)

…you can manually trigger a re-send. First confirm the email address they used (don't assume — ask "Just to confirm, what email did you sign up with?"). Once they give you the email, emit a single message that ends with this marker on its own line:

[RESEND_EMAILS]{"email":"student@example.com"}

CRITICAL FORMAT RULES (same as [CREATE_ENROLLMENT]):
- The marker MUST be the last thing in your message — no text after it.
- JSON on a single line, double quotes only.
- The frontend will hide the marker, call the resend endpoint, and show a confirmation card. Do NOT explain the marker to the user.

After the marker fires the frontend will inject a [SYSTEM: Resend result ...] message — your follow-up should:
- If success: "Done — I just re-sent both emails to [email]. Check your inbox in the next 30 seconds (and your spam folder just in case)."
- If failure: apologize and offer the support email info@aatatraining.org.

### When students return ("Check enrollment status")
The chatbot has a "Check my enrollment status" button. When they click it, look up their current Salesforce status and tell them what to do next:
- **Step 1 Complete / DAS Sent** → "Check your email — we sent you the DAS 1 Apprentice Agreement to sign"
- **DAS Signed** → "You signed your DAS 1 — the Foothill enrollment + book fee payment emails are on their way"
- **Emails Sent** → "Check your email for the Foothill College application + book fee payment instructions. Have you completed those?"
- **Payment Received** → "Payment received! You're almost fully enrolled."
- **Fully Enrolled** → "You're all set! Welcome to AATA!"
- **Not found** → Start a fresh enrollment

## ENROLLMENT FLOW CONVERSATION STRATEGY
When a student says they want to enroll or are ready to sign up:
1. First, ask: "Which state do you currently reside in?"
2. Based on their answer:
   - California resident → Continue to step 2a (residency duration check)
   - Texas resident → Direct them to contact Patrick Kratochvil at ${get("phone_tx", "(281) 676-0356")} or ${get("email_tx", "patrickaata@gmail.com")} for enrollment
   - Out-of-state resident → Explain funding is handled case by case, direct them to leave a message at https://www.aatatraining.org/apply

2a. **For California residents only — residency duration check (BEFORE collecting the 9 fields):**
   Ask: "Quick funding question — have you been a California resident for at least the past year?"
   - If YES (or "lived here all my life", "5 years", etc.): Explain the funding source clearly and warmly. Example: *"Perfect — that means you qualify for the California State apprenticeship funding. The state covers your full $7,495 tuition because NDT is one of the skilled trades California is actively trying to grow. Your only out-of-pocket cost is the $325 ASNT book fee."* Then begin the 9-field collection.
   - If NO (recently moved, less than ~1 year): Politely explain that California's apprenticeship funding requires roughly 1+ year of in-state residency, so they may not be eligible yet through this funding path. Direct them to leave a message at https://www.aatatraining.org/apply so AATA staff can advise on alternatives. Do NOT proceed with the 9-field collection.
   - If UNCLEAR ("I think so", "not sure"): Ask for the approximate move-in month/year, then apply the rule above.

3. For eligible CA residents: collect the 9 fields one by one, confirm, then emit the [CREATE_ENROLLMENT] marker
4. After the marker is emitted, set expectations about the auto-emails (DAS in 1-2 min, then 2 auto-emails after they sign) — no more manual steps

IMPORTANT RULES ABOUT VETERANS:
- Do NOT ask if someone is a veteran as a qualifying question
- Do NOT proactively mention veteran benefits or veteran-specific funding
- If a student independently mentions they are a veteran AND asks about funding, explain that funding is handled on a case-by-case basis and direct them to https://www.aatatraining.org/apply
- If a CA or TX resident happens to be a veteran, their state residency already qualifies them for free/funded tuition

## CAREER OUTLOOK
- Some AATA graduates earn $42-$47/hour
- With overtime, that adds up to $110,000+ annually within a couple of years of experience
- Industries: Aerospace, aviation, oil & gas, manufacturing, construction, power generation

## CONTACT
- General / California: info@aatatraining.org
- Houston / Texas: Patrick Kratochvil at ${get("phone_tx", "(281) 676-0356")} or ${get("email_tx", "patrickaata@gmail.com")}
- Pratik Wagh (enrollment confirmation): ${get("pratik_phone", "+1 424-385-1149")}
- Apply online / Leave a message: www.aatatraining.org/apply
- Website: www.aatatraining.org

## CONNECTING TO A LIVE AGENT
If a student asks to speak with a person, be connected to an agent, or wants to talk to someone:
- Direct them to call: ${get("phone_live", "323-761-9066")}
- If the call doesn't go through, ask them to email: info@aatatraining.org
- Do NOT provide any other phone numbers for live agent requests

## BEHAVIOR GUIDELINES
- IMPORTANT: Do NOT use markdown headers (# or ##) in your responses. Use **bold text** for emphasis instead.
- Always be encouraging — many prospective students may be nervous about a career change
- If someone is a CA resident, frame the free tuition as **California State apprenticeship funding** — not a discount AATA gives out. Specifically: the state of California covers the $7,495 because NDT/aerospace is a priority skilled trade with workforce shortage, and they fund qualified residents (1+ year residency) directly. This makes the offer feel legitimate and government-backed, not too-good-to-be-true.
- If someone is a TX resident, warmly direct them to Patrick Kratochvil
- NEVER proactively mention veteran benefits or veteran-specific funding
- Create urgency about limited spots (mention exact spots remaining for each class)
- For CA students, after they pick a class, begin the conversational data collection (one field at a time) and emit [CREATE_ENROLLMENT]{...} once everything is confirmed
- After the [CREATE_ENROLLMENT] marker is emitted, set expectations: DAS email arrives in 1-2 min, then 2 auto-emails after they sign
- If you don't know something specific, direct them to contact AATA directly
- Keep responses concise: 3-6 sentences for simple questions, more detail only when asked
- Never make up information not in your knowledge base — direct to AATA contact instead
- If asked about topics unrelated to AATA enrollment, politely redirect to enrollment topics`;
}

// ============================================================
// CHAT ENDPOINT
// ============================================================
app.post("/api/chat", async (req, res) => {
  // 60 chat turns per IP per hour. Real student conversations are 15–25
  // turns, so 60 is generous for one student but blocks scripted spam.
  if (!rateLimit(req, res, {
    endpoint: "chat", windowMs: 60 * 60 * 1000, max: 60,
    message: "You're sending messages a bit too fast. Please wait a minute and try again.",
  })) return;

  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }
    const systemPrompt = await buildSystemPrompt();
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages,
    });
    res.json(response);
  } catch (err) {
    console.error("API Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CREATE ENROLLMENT — chatbot-collected data → SF Contact + Class Registration
// Triggers AATA_ContactEnrollmentTrigger (Apex) which fires Box Sign DAS
// ============================================================
async function sfCreate(sObject, payload) {
  if (!sfAuth.access_token) await sfAuthenticate();
  const url = `${sfAuth.instance_url}/services/data/v59.0/sobjects/${sObject}`;
  let res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sfAuth.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    await sfAuthenticate();
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sfAuth.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }
  return { status: res.status, body: await res.json() };
}

app.post("/api/create-enrollment", async (req, res) => {
  // Hard cap: 3 enrollments per IP per 24h. Genuine students enroll ONCE.
  // This is the most expensive endpoint (writes a Contact + Class
  // Registration + fires Box Sign + 2 future emails), so guard it tightly.
  if (!rateLimit(req, res, {
    endpoint: "create-enrollment", windowMs: 24 * 60 * 60 * 1000, max: 3,
    message: "We've already received an enrollment from this device today. If you need to fix something, email info@aatatraining.org.",
  })) return;

  const REQUIRED = [
    "firstName", "lastName", "email", "mobilePhone",
    "mailingStreet", "mailingCity", "mailingState", "mailingPostalCode",
    "classSelection",
  ];
  const data = req.body || {};
  const missing = REQUIRED.filter((k) => !data[k] || String(data[k]).trim() === "");
  if (missing.length) {
    return res.status(400).json({ ok: false, error: "Missing required fields", missing });
  }
  // Email format + disposable-domain check
  const email = String(data.email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "That email address doesn't look right. Please use a valid email." });
  }
  if (looksDisposableEmail(email)) {
    return res.status(400).json({ ok: false, error: "Please use a real, non-temporary email address — we'll be sending your DAS form, Foothill instructions, and book payment details there." });
  }
  // Reject obviously-fake names
  if (looksFakeName(data.firstName) || looksFakeName(data.lastName)) {
    return res.status(400).json({ ok: false, error: "Please enter your real first and last name." });
  }
  if (!["Day Class", "Night Class"].includes(data.classSelection)) {
    return res.status(400).json({
      ok: false,
      error: `classSelection must be "Day Class" or "Night Class", got "${data.classSelection}"`,
    });
  }
  // Privacy / consent — required, can't bypass
  if (data.consentAgreed !== true) {
    return res.status(400).json({
      ok: false,
      error: "Consent to data collection is required before we can create your enrollment.",
    });
  }
  // Validate timestamp; fall back to now() if it looks malformed (chatbot
  // sometimes drops microseconds or trailing Z)
  let consentTs = data.consentTimestamp;
  if (!consentTs || isNaN(Date.parse(consentTs))) {
    consentTs = new Date().toISOString();
  }
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    return res.status(500).json({ ok: false, error: "SF credentials not configured" });
  }

  try {
    // 1. Find the matching open class in Salesforce (by Day vs Night in Name)
    const classFilter = data.classSelection === "Day Class" ? "DAY" : "NIGHT";
    const classQuery = await sfQuery(
      `SELECT Id, Name, yClasses__First_Session_Date__c, Spots_Remaining__c ` +
      `FROM yClasses__Class__c WHERE Registration_Open__c = true AND Name LIKE '%${classFilter}%' ` +
      `ORDER BY yClasses__First_Session_Date__c ASC LIMIT 1`
    );
    const matchedClass = (classQuery.records || [])[0];
    if (!matchedClass) {
      return res.status(409).json({
        ok: false,
        error: `No open ${data.classSelection} found. Please contact info@aatatraining.org.`,
      });
    }

    // 2. Create the Contact (Apex trigger fires Box Sign on insert)
    const contactPayload = {
      FirstName: data.firstName,
      LastName: data.lastName,
      Email: data.email,
      MobilePhone: data.mobilePhone,
      MailingStreet: data.mailingStreet,
      MailingCity: data.mailingCity,
      MailingState: data.mailingState,
      MailingPostalCode: data.mailingPostalCode,
      Class_Selection__c: data.classSelection,
      Enrollment_Status__c: "Step 1 Complete",
      Enrollment_Source__c: "AI Chatbot",
      Consent_Agreed__c: true,
      Consent_Timestamp__c: consentTs,
    };
    const contactRes = await sfCreate("Contact", contactPayload);
    if (contactRes.status !== 201 || !contactRes.body.id) {
      console.error("Contact create failed:", contactRes.body);
      return res.status(500).json({ ok: false, error: "Contact create failed", details: contactRes.body });
    }
    const contactId = contactRes.body.id;
    console.log("Created Contact:", contactId, "for", data.email);

    // 3. Create the Class Registration linking student to the matched class
    const regRes = await sfCreate("yClasses__Class_Registration__c", {
      yClasses__Student__c: contactId,
      yClasses__Class__c: matchedClass.Id,
    });
    if (regRes.status !== 201) {
      console.error("Class registration create warning:", regRes.body);
      // Don't fail — contact + DAS still proceed
    }

    res.json({
      ok: true,
      contactId,
      className: matchedClass.Name,
      classStartDate: matchedClass.yClasses__First_Session_Date__c,
      message: "Contact created. DAS 1 e-signature email will arrive within 1-2 minutes.",
    });
  } catch (err) {
    console.error("Create enrollment error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// RESEND ENROLLMENT EMAILS — chatbot-initiated recovery path for when
// the Box → SF webhook silently fails. Forwards to the SF Apex REST
// endpoint with the FORCE_RESEND trigger.
// ============================================================
app.post("/api/resend-enrollment-emails", async (req, res) => {
  // 5 resends per IP per hour. Real students need 1, maybe 2 if first
  // batch hits spam. More than that = abuse.
  if (!rateLimit(req, res, {
    endpoint: "resend", windowMs: 60 * 60 * 1000, max: 5,
    message: "Too many resend attempts. Please email info@aatatraining.org for help.",
  })) return;

  const email = (req.body && req.body.email || "").trim();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ ok: false, error: "Valid email is required" });
  }
  try {
    const sfRes = await fetch(
      "https://americanaerospacetechnicalacademy.my.salesforce-sites.com/services/apexrest/boxsign/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "FORCE_RESEND", email }),
      }
    );
    const body = await sfRes.json();
    if (sfRes.status === 200 && body.status === "resent") {
      return res.json({ ok: true, contactId: body.contactId, message: "Emails re-sent" });
    }
    if (sfRes.status === 404) {
      return res.status(404).json({ ok: false, error: "We couldn't find an enrollment with that email. Did you maybe sign up with a different one?" });
    }
    return res.status(500).json({ ok: false, error: body.error || `SF returned ${sfRes.status}` });
  } catch (err) {
    console.error("Resend error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================
// WEBHOOK CAPTURE — diagnostic-only. Logs incoming POSTs in memory and
// returns 200, so we can see whether Box is actually delivering anything.
// View captured calls via GET /api/webhook-capture/log
// ============================================================
const webhookCaptureLog = [];
app.post("/api/webhook-capture", express.text({ type: "*/*" }), (req, res) => {
  const entry = {
    ts: new Date().toISOString(),
    method: req.method,
    headers: req.headers,
    body: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
    ip: req.ip || req.headers["x-forwarded-for"] || null,
  };
  webhookCaptureLog.push(entry);
  if (webhookCaptureLog.length > 50) webhookCaptureLog.shift();
  console.log("[WEBHOOK-CAPTURE]", entry.ts, "from", entry.ip, "body:", entry.body.slice(0, 200));
  res.status(200).json({ captured: true });
});
app.get("/api/webhook-capture/log", (req, res) => {
  res.json({ count: webhookCaptureLog.length, entries: webhookCaptureLog });
});

// ============================================================
// ENROLLMENT STATUS ENDPOINT (returning student lookup)
// ============================================================
app.get("/api/enrollment-status", async (req, res) => {
  const email = (req.query.email || "").trim();
  if (!email) {
    return res.status(400).json({ found: false, error: "email is required" });
  }
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    return res.status(500).json({ found: false, error: "SF credentials not configured" });
  }
  try {
    const safeEmail = email.replace(/'/g, "\\'");
    const soql =
      `SELECT Id, FirstName, LastName, Email, Enrollment_Status__c, Class_Selection__c, ` +
      `Box_Sign_Request_ID__c, DAS_Signed_Date__c ` +
      `FROM Contact WHERE Email = '${safeEmail}' ` +
      `ORDER BY CreatedDate DESC LIMIT 1`;
    const result = await sfQuery(soql);
    if (!result.records || result.records.length === 0) {
      return res.json({ found: false });
    }
    const c = result.records[0];
    res.json({
      found: true,
      contactId: c.Id,
      firstName: c.FirstName,
      lastName: c.LastName,
      email: c.Email,
      enrollmentStatus: c.Enrollment_Status__c,
      classSelection: c.Class_Selection__c,
      hasBoxSignRequest: !!c.Box_Sign_Request_ID__c,
      dasSignedDate: c.DAS_Signed_Date__c,
    });
  } catch (err) {
    console.error("Enrollment status error:", err.message);
    res.status(500).json({ found: false, error: err.message });
  }
});

// ============================================================
// AVAILABLE CLASSES ENDPOINT (used by chatbot UI for class picker)
// ============================================================
app.get("/api/available-classes", async (req, res) => {
  try {
    const records = await fetchSalesforceClasses();
    const classes = records.map((r) => ({
      id: r.Id,
      name: r.Name,
      totalSpots: r.Total_Spots__c,
      enrolled: r.Enrollment_Count__c,
      spotsRemaining: r.Spots_Remaining__c,
      startDate: r.yClasses__First_Session_Date__c,
      endDate: r.yClasses__Last_Session_Date__c,
    }));
    res.json({ classes });
  } catch (err) {
    console.error("Available classes error:", err.message);
    res.status(500).json({ error: err.message, classes: [] });
  }
});

// /health — actively probes every dependency and returns 200 only if
// EVERYTHING is working. External uptime monitors (UptimeRobot, Better
// Uptime, etc.) should ping this every 5 min and alert on non-200.
// ============================================================
// STAFF QUERY — internal AATA staff Q&A bot, READ-ONLY against Salesforce.
// Two-pass:
//   1. Claude translates the natural-language question into SOQL
//   2. Backend validates (SELECT-only, no DML keywords) + executes
//   3. Claude formats results back into plain English
// Auth: shared PIN sent in body. Rate-limited per IP.
// ============================================================
const STAFF_PIN = process.env.STAFF_PIN || "AATA2026";

const SOQL_SCHEMA_HINT = `
Available Salesforce objects and their queryable fields. Use ONLY these fields and objects.

### Contact (the student record)
Standard: Id, FirstName, LastName, Name, Email, MobilePhone, Phone, Birthdate,
MailingStreet, MailingCity, MailingState, MailingPostalCode, AccountId, Account.Name,
CreatedDate, LastModifiedDate
Custom: Enrollment_Status__c (picklist: "Step 1 Complete", "DAS Sent", "DAS Signed",
"Emails Sent", "Payment Received", "Fully Enrolled"), Enrollment_Source__c,
Class_Selection__c, Class__c (lookup to yClasses__Class__c, use Class__r.Name),
Class_Registration__c, SSN__c (text), SSN_Last_Four__c (number),
DAS_Signed_Date__c (date), DAS_Signature__c, DAS_Execution_Date__c,
Box_Sign_Request_ID__c, Foothill_CWID__c, Received_Book_Fees__c (currency),
Highest_Education__c, Military_Service__c, Years_Employed__c, Number_of_Dependents__c,
Ethnicity__c, Gender__c, Vet_Status__c, Employment_Status__c, Funder__c (lookup),
Self_Funded__c, Student_Status__c, County_of_Residence__c, Consent_Agreed__c,
Consent_Timestamp__c, Typed_Signature__c, Class_Interest__c

### yClasses__Class__c (a single class cohort)
Id, Name, yClasses__First_Session_Date__c, yClasses__Last_Session_Date__c,
Total_Spots__c, Enrollment_Count__c, Spots_Remaining__c, Registration_Open__c,
CreatedDate

### yClasses__Class_Registration__c (links a Contact to a Class)
Id, yClasses__Student__c (Contact lookup, use Student__r.Name),
yClasses__Class__c (Class lookup, use Class__r.Name),
yClasses__Grade__c, CreatedDate

### yClasses__Attendance__c (per-session attendance record)
Id, yClasses__Class_Registration__c (lookup),
yClasses__Class_Session__c (lookup), yClasses__Status__c (picklist: Attended/Late/Excused/No Show/Early Release/Not Scheduled),
yClasses__Date__c, CreatedDate
`;

app.post("/api/staff-query", async (req, res) => {
  // Rate limit — 40 staff queries per IP per hour
  if (!rateLimit(req, res, {
    endpoint: "staff", windowMs: 60 * 60 * 1000, max: 40,
    message: "Hold up — too many queries in the last hour. Try again in a bit.",
  })) return;

  const { question, pin } = req.body || {};
  if (pin !== STAFF_PIN) {
    return res.status(401).json({ ok: false, error: "Invalid staff PIN" });
  }
  if (!question || String(question).trim().length < 3) {
    return res.status(400).json({ ok: false, error: "Question is required" });
  }
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    return res.status(500).json({ ok: false, error: "SF credentials not configured" });
  }

  // STEP 1: Claude generates SOQL
  let soql;
  try {
    const r1 = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: `You translate AATA staff questions into Salesforce SOQL SELECT queries.

OUTPUT RULES (strict):
- Output ONLY a single SOQL statement starting with SELECT.
- No explanation, no comments, no code fences, no markdown, no trailing semicolon.
- Default LIMIT 50 unless the user asks for "all" (then up to 200) or for a count (use COUNT()).
- For date filters use SOQL date literals: TODAY, YESTERDAY, LAST_N_DAYS:N, THIS_WEEK, THIS_MONTH, THIS_YEAR.
- For COUNT queries use the form: SELECT COUNT() FROM Contact WHERE ...
- For aggregates (group by status, etc.) use the form: SELECT Enrollment_Status__c, COUNT(Id) FROM Contact GROUP BY Enrollment_Status__c
- Use relationship dot notation for parent fields (e.g., Class__r.Name).
- For child relationships use subqueries.
- If the user asks something that requires writing/changing data, output exactly: SELECT 'CANNOT_MODIFY' FROM Contact LIMIT 1
${SOQL_SCHEMA_HINT}`,
      messages: [{ role: "user", content: String(question) }],
    });
    soql = r1.content?.[0]?.text?.trim() || "";
  } catch (err) {
    console.error("Staff SOQL gen failed:", err.message);
    return res.status(500).json({ ok: false, error: "Could not generate query: " + err.message });
  }

  // Strip any code fences Claude might have added despite instructions
  soql = soql.replace(/^```(?:sql|soql)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Strip trailing semicolon if any
  soql = soql.replace(/;\s*$/, "").trim();

  // SECURITY GUARDRAILS
  if (!/^\s*SELECT\s/i.test(soql)) {
    return res.json({
      ok: true,
      answer: "I can only run read-only queries — try rephrasing as a question (e.g., 'how many...' or 'show me...').",
      soql,
    });
  }
  if (/\b(UPDATE|INSERT|DELETE|UPSERT|MERGE|CREATE|DROP|ALTER|TRUNCATE|EXEC|EXECUTE)\b/i.test(soql)) {
    return res.json({
      ok: true,
      answer: "Read-only access only — I can't modify Salesforce data. If you need to make a change, do it directly in SF.",
      soql,
    });
  }
  if (soql.includes("CANNOT_MODIFY")) {
    return res.json({
      ok: true,
      answer: "That request would require modifying data, which this read-only assistant can't do. Please make the change directly in Salesforce.",
    });
  }

  // EXECUTE
  let results;
  try {
    results = await sfQuery(soql);
    // sfQuery returns either {records: [...]} or an error array/object
    if (Array.isArray(results) && results[0]?.errorCode) {
      return res.json({
        ok: true,
        answer: `The query failed in Salesforce:\n\n**${results[0].errorCode}**: ${results[0].message}\n\n_Generated SOQL:_ \`${soql}\`\n\nTry rephrasing your question and I'll regenerate the query.`,
        soql,
      });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Salesforce query failed: " + err.message, soql });
  }

  // STEP 2: Claude formats the results into plain English
  const resultsTrunc = JSON.stringify(results).slice(0, 12000);
  let answer;
  try {
    const r2 = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: `You are an internal AATA staff data assistant. The user asked a question about Salesforce data and you've already retrieved the answer (the query has already run — you don't need to run it). Format the results in clean plain English.

Style:
- Be concise. No filler ("Great question!" etc.).
- Use markdown tables when listing multiple records with multiple fields.
- Use bullet lists for short item lists.
- For COUNT queries, just state the number plainly.
- For aggregate queries (GROUP BY), show as a table.
- Format dates as "Aug 3, 2026" not ISO strings.
- Format currency with $.
- If the result set is empty, say "No matching records." plainly.
- If you display SSN or other sensitive data, ALWAYS preface with: "⚠️ Sensitive data — handle with care:"
- At the very end (small, italic, on its own line), add: "_Source: Salesforce live query_"`,
      messages: [{
        role: "user",
        content: `Question: ${question}\n\nSOQL that ran: \`${soql}\`\n\nSF result (JSON, may be truncated):\n${resultsTrunc}`,
      }],
    });
    answer = r2.content?.[0]?.text || "(no response)";
  } catch (err) {
    console.error("Staff format failed:", err.message);
    return res.status(500).json({ ok: false, error: "Could not format response: " + err.message });
  }

  res.json({
    ok: true,
    answer,
    soql,
    recordCount: (results.records || []).length,
  });
});

app.get("/health", async (req, res) => {
  const result = {
    status: "ok",
    timestamp: new Date().toISOString(),
    checks: {},
  };

  // 1. Anthropic key present
  result.checks.anthropic_key = process.env.ANTHROPIC_API_KEY ? "ok" : "MISSING";
  if (!process.env.ANTHROPIC_API_KEY) result.status = "degraded";

  // 2. Salesforce — actually try to auth and run a trivial query
  try {
    if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) throw new Error("SF credentials env vars missing");
    const r = await sfQuery("SELECT Id FROM Contact LIMIT 1");
    if (r.errorCode) throw new Error(r.message || r.errorCode);
    result.checks.salesforce = "ok";
  } catch (err) {
    result.checks.salesforce = "FAIL: " + err.message;
    result.status = "degraded";
  }

  // 3. Salesforce class data fresh
  try {
    const classes = await fetchSalesforceClasses();
    result.checks.open_classes = `${classes.length} open`;
    if (classes.length === 0) {
      result.checks.open_classes += " (warning: 0 classes available for enrollment)";
    }
  } catch (err) {
    result.checks.open_classes = "FAIL: " + err.message;
    result.status = "degraded";
  }

  // 4. Google Sheet reachable (config overrides)
  try {
    const sheet = await fetchGoogleSheet();
    result.checks.google_sheet = `${Object.keys(sheet).length} entries`;
  } catch (err) {
    result.checks.google_sheet = "FAIL: " + err.message;
    result.status = "degraded";
  }

  // 5. SF Apex webhook endpoint reachable (the canonical email-trigger path)
  try {
    const probe = await fetch(
      "https://americanaerospacetechnicalacademy.my.salesforce-sites.com/services/apexrest/boxsign/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "FORCE_RESEND" }), // missing email → handler returns 400 which proves it's alive
      }
    );
    if (probe.status === 400 || probe.status === 200) {
      result.checks.sf_webhook = "ok";
    } else {
      result.checks.sf_webhook = `unexpected status ${probe.status}`;
      result.status = "degraded";
    }
  } catch (err) {
    result.checks.sf_webhook = "FAIL: " + err.message;
    result.status = "degraded";
  }

  res.status(result.status === "ok" ? 200 : 503).json(result);
});

// /health/quick — fast, no external calls. For Railway's own
// container health checks (don't want them hammering SF/Box every 30s).
app.get("/health/quick", (req, res) => {
  res.status(200).json({ status: "ok", uptime_sec: Math.floor(process.uptime()) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AATA Proxy Server running on port ${PORT}`);
  fetchGoogleSheet().then(() => console.log("Initial Google Sheet fetch complete"));
  fetchSalesforceClasses().then(() => console.log("Initial Salesforce fetch complete"));
});
