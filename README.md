# FORM Cycling

Film yourself on your trainer with a phone. FORM measures how you sit and pedal —
averaged over every stroke — and coaches **one honest fix** at a time.
Sister app to FORM Golf; same account, same honesty rules.

## Architecture

- **Static web app** — no build step. Plain ES modules, hash routing (`js/main.js`).
  Deploys straight to GitHub Pages.
- **Auth + data: Supabase** — the *same project as FORM Golf* (one login across FORM apps).
  Sign-in is a numeric code emailed to you (`signInWithOtp` → `verifyOtp`) — no passwords.
  Code length lives in `OTP_LENGTH` (`js/config.js`) and must match the dashboard setting.
  Cycling data lives in `public.cycling_sessions` (RLS: users see only their own rows).
  Config in `js/config.js` (publishable key only — safe to commit).
- **Voice coach: OpenAI Realtime** — `js/pages/coach.js` opens a WebRTC session
  straight to OpenAI, so audio never passes through our servers. The key never
  reaches the browser: `supabase/functions/coach-token` holds it and returns a
  client secret that lasts about a minute, and only to a signed-in rider. The
  coach is instructed server-side that it may choose its words but never a
  measurement — every figure it says comes from the stored report. With no key
  set it falls back to the browser's own speech synthesis and says so.
- **Analysis runs on-device** — MediaPipe Pose Landmarker (WASM) in the browser
  (`js/analysis.js`). Videos never leave the phone; only measurement results are stored.
- **Pages**: Login (+ filming intro) · Home (development over time) · Analyze
  (guided 3-view capture → trim → on-device analysis → report) · Journey (locked) ·
  Drills (locked) · Profile.

## Honesty rules (non-negotiable, shared with FORM Golf)

1. One fix per report. Everything else is a parked, measured card.
2. No measurement → no number, no verdict, no drawing.
3. Failed read → the quality gate owns the screen (re-record, no celebration).
4. Every band cites research (see below). No invented thresholds.
5. Overlays are drawn only anchored to joints visible in that exact frame.

Bands used (`js/config.js`): dynamic knee 30–40° (Cycling Weekly / physio guidance) ·
hip 44–58°, ankle 75–105°, foot toe-down 5–20° at 6 o'clock (Bike Fit Adviser) ·
cadence 75–95 rpm (TrainerRoad research review) · aero trade-offs (Fintelman 2014, AeroX).

## Deploy (GitHub Pages)

1. Create repo `form-cycling`, push these files to `main`.
2. Repo Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. App is live at `https://<user>.github.io/form-cycling/` — bookmark / Add to Home Screen.
4. Supabase → Auth → URL Configuration: add that URL to *Site URL / Redirect URLs*.
5. Supabase → Auth → Email Templates → *Magic Link*: the body must contain `{{ .Token }}`
   so the mail carries a code (a link-only template will send a link instead, and the
   code field will have nothing to accept).
6. Supabase → Auth → Providers → Email → *Email OTP Length* (6–10) must equal `OTP_LENGTH`
   in `js/config.js`. They only drive copy and auto-submit — any code of 6+ digits can
   still be submitted by hand, and Supabase is the one that accepts or rejects it.

## Tests

```
node tests/run.mjs              # every suite
node tests/run.mjs nav gate     # only matching suites
npx playwright install chromium # once, if it is not already there
```

The runner serves this repo over HTTP on an ephemeral port and drives the real
app in a real browser — there is no build step, so what the browser loads is
what ships. It exits non-zero on any failure.

Suites are plain modules; run one directly with `node tests/angles.test.mjs`.
Each check prints what it actually measured rather than "ok", because the
measurement is the documentation:

```
PASS — your 28° ±3.1° is too close to call :: verdict="borderline" (band edge 2° away, spread 3.1°)
PASS — drawn joint lands on the real marker :: drawn (251.3,111.1) vs marker (251.1,110.8) — 0.4px apart
```

Some suites exist because a specific bug shipped and should not come back:

- `angles` — the aspect-ratio distortion that inverted a saddle verdict.
- `canvas-size` — the stale canvas height that slid the overlay off the rider.
- `seek-safety` — the unbounded `seeked` wait that hung the analysis at 40%.
- `verdicts` — prescribing a saddle change from a gap smaller than the rider's
  own stroke-to-stroke spread.
- `overlay-on-video` — builds a clip with markers at known coordinates and
  checks the drawn skeleton lands on them.

## Capture quality gate

Every read is graded from the footage itself (`gradeCapture` in `js/analysis.js`,
thresholds in `CAPTURE` in `js/config.js`):

- **F — refused.** The model saw you in under half the frames, or never saw hip,
  knee and ankle clearly. The gate owns the screen; no numbers travel with it.
- **C — provisional.** The camera was more than 15° off square (rule 3's own
  number), or you left the frame. The camera becomes the headline fix, and every
  measurement keeps its value but loses its verdict word.
- **A/B — trusted.** The report reads normally.

Squareness is inferred, not measured: filmed truly side-on the two hips project
onto nearly the same point, and dividing their separation by trunk length gives
an approximate yaw. It assumes a population hip-to-trunk proportion, so it grades
the camera rather than measuring it — which is why it only ever downgrades a
report and never produces a coaching number. **These thresholds have not been
calibrated against real footage yet.** Tune `CAPTURE` once there are clips to
check them against.

## Voice coach setup (one secret, set once)

The Edge Function is deployed. It needs the key, which must never be committed:

```
supabase secrets set OPENAI_API_KEY=sk-...   # or Dashboard → Edge Functions → coach-token → Secrets
```

Optional: `COACH_MODEL` (default `gpt-realtime`) and `COACH_VOICE` (default `verse`).

Until that secret exists the function answers 503 and the app falls back to the
preview voice, naming the reason on screen. Nothing breaks; it just isn't live.

## Roadmap (from the Ride Report 001 prototype + tester feedback, in order)

- **Two-position protocol ("position ladder")** — tester-validated: real fits measure
  upright AND aero. Capture both; report shows hip closure cost vs. aero gain per
  position. Hip fold at the top of the stroke is the governing metric (too closed =
  the hip "shuts off the work").
- **Saddle tilt** from the side view (line-fit on the visible saddle edge) and
  **saddle setback** once the bottom bracket is located in-frame.
- **Stem & spacer recommendations** — not measured as parts, but translated from body
  measurements ("reach 2 cm long → try a 10–20 mm shorter stem; hands low + neck
  strained → add a spacer"). Recommendations, clearly framed as such.
- Report media: annotated keyframes + master video with Side/Front/Behind toggle
  and playback-speed control (see Ride Report 001 artifact for the target design).
- Slow-motion (60 fps+) foot close-up → cleat fore-aft (tester-requested) + true knee-over-spindle.
- .fit ride-file upload → position vs real watts ("power" claims only after this).
- Tape-measure calibration (saddle height) → centimeter-exact output + accuracy validation.

## Shared-shell contract (for FORM Golf / Running maintainers)

The report structure (fix card → conclusions → master video → collapsible measured
cards) and the glass design tokens in `css/app.css` are intended to become the
shared FORM report shell. Don't fork them — lift them.

## Which build am I looking at?

Tap the small `v1` pill in the top-right corner. It shows three things:

- **page** — the build string in `index.html`, which arrives with the document
- **scripts** — the build string in `js/config.js`, which arrives inside a module
- **worker** — whether the network-first service worker is in control

They are two separate strings on purpose. The page revalidates aggressively;
modules can sit in the browser's cache for days. If the two disagree, the phone
is running old JavaScript and the panel says so instead of letting it look like
a broken feature. **Force refresh** clears every cache, drops the worker, and
reloads on a URL the cache cannot answer.

Bump both on every deploy: `BUILD` in `js/config.js` and `data-build` /
`<meta name="form-build">` in `index.html`. `tests/version.test.mjs` fails if
they drift apart.
