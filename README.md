# FORM Running

Film yourself on a treadmill with a phone. FORM measures how you carry yourself
and how you land — averaged over every stride — and coaches **one honest fix**
at a time. Sister app to FORM Golf and FORM Cycling; same account, same honesty
rules, same report shell.

## Architecture

- **Static web app** — no build step. Plain ES modules, hash routing (`js/main.js`).
  Deploys straight to GitHub Pages.
- **Auth + data: Supabase** — the *same project as FORM Golf and FORM Cycling*
  (one login across FORM apps). Sign-in is a numeric code emailed to you
  (`signInWithOtp` → `verifyOtp`) — no passwords. Code length lives in
  `OTP_LENGTH` (`js/config.js`) and must match the dashboard setting.
  Running data lives in `public.running_sessions` (RLS: users see only their own
  rows; see `supabase/migrations/`). Config in `js/config.js` (publishable key
  only — safe to commit).
- **Voice coach: OpenAI Realtime** — `js/pages/coach.js` opens a WebRTC session
  straight to OpenAI, so audio never passes through our servers. The key never
  reaches the browser: `supabase/functions/coach-token` holds it and returns a
  client secret that lasts about a minute, and only to a signed-in runner. The
  coach is instructed server-side that it may choose its words but never a
  measurement — every figure it says comes from the stored report.
- **Analysis runs on-device** — MediaPipe Pose Landmarker (WASM) in the browser
  (`js/analysis.js`). Videos never leave the phone; only measurement results are stored.
- **Pages**: Login (+ filming intro) · Home (development over time) · Analyze
  (guided 3-view capture → trim → on-device analysis → report) · Coach · Journey
  (locked) · Profile.

## Honesty rules (non-negotiable, shared across FORM)

1. One fix per report. Everything else is a parked, measured card.
2. No measurement → no number, no verdict, no drawing.
3. Failed read → the quality gate owns the screen (re-record, no celebration).
4. Every band cites research. No invented thresholds.
5. Overlays are drawn only anchored to joints visible in that exact frame.

### What running does differently: most numbers carry no verdict

This is the biggest departure from FORM Cycling, and it is deliberate. Bike fit
has a mature literature of joint-angle windows. Running does not — and the
thresholds that do exist are usually stated in units a single phone camera
cannot reproduce (force plates, motion capture, absolute centimetres).

So FORM Running bands **two** things and reports the rest without judgement:

| Measured | Banded? | Source |
|---|---|---|
| Cadence (steps/min) | **170–180** | Heiderscheit et al. 2011; Schubert, Kempf & Heiderscheit 2014 |
| Trunk lean from vertical | **8–14°** | Teng & Powers 2014 |
| Knee flexion at contact | no | no cited band in these units |
| Shin angle at contact (overstriding) | no | research not reproducible from one camera |
| Vertical travel (% of leg length) | no | no band exists in this unit |
| Knee sway, front view | no | left/right *evenness* is judged — that compares you to yourself |
| Pelvic tilt range, rear view | no | published thresholds describe peak single-leg drop, a different quantity |

Two caveats we state in the app rather than hide:

- The cadence window is **guidance, not a universal target**. The trials behind
  it raised each runner's own step rate by 5–10%; they do not license calling
  168 spm wrong. Above the window FORM reports the number and claims nothing —
  no research supports treating a high step rate as a fault.
- Left/right asymmetry *is* judged, because it compares a runner with
  themselves and needs no external threshold.

## Measuring cadence honestly (why 20 fps and sub-frame peaks)

The gait cycle is found from the near ankle's height: it is lowest when that
foot is on the belt. Those troughs are **one foot's** contacts, so they are
strides — cadence is quoted in steps, which is twice the stride rate. Getting
that factor wrong would put every runner exactly one octave out.

Two accuracy problems had to be solved before the band meant anything:

1. **Frame rate.** A foot is on the ground for roughly a fifth of a second, so
   FORM Cycling's 15 fps can miss the contact frame. Running samples at 20 fps
   over a shorter window, keeping the number of seeks about the same.
2. **Quantisation.** Even at 20 fps, a stride period lands on whole frames.
   Near 176 spm that quantises to 171.4 or 184.6 — a 13 spm step, **wider than
   the 10 spm band itself**, so the sampling grid alone could decide the
   verdict. `refineContacts` fits a parabola through each peak and its
   neighbours to place the contact between samples. Against synthetic strides
   this takes the worst error from **8.6 spm to 0.26 spm**.

The reported spread and the verdict use different quantities, on purpose. The
spread quoted on the card is stride-to-stride and includes how precisely a phone
can time a footfall. The *verdict* tests the band edge against the standard
error of the mean — how firmly the average is pinned — because a verdict is a
claim about your average, not about any one stride. Testing against the raw
spread would mark almost every honest read "too close to call".

## Deploy (GitHub Pages)

1. Create repo `form-running`, push these files to `main`.
2. Repo Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. App is live at `https://<user>.github.io/form-running/` — bookmark / Add to Home Screen.
4. Supabase → Auth → URL Configuration: add that URL to *Site URL / Redirect URLs*.
5. Supabase → Auth → Email Templates → *Magic Link*: the body must contain `{{ .Token }}`
   so the mail carries a code (a link-only template will send a link instead, and the
   code field will have nothing to accept).
6. Supabase → Auth → Providers → Email → *Email OTP Length* (6–10) must equal `OTP_LENGTH`
   in `js/config.js`.
7. Apply `supabase/migrations/20260827000000_running_sessions.sql` if the table
   does not exist yet.

## Capture quality gate

Every read is graded from the footage itself (`gradeCapture` in `js/analysis.js`,
thresholds in `CAPTURE` in `js/config.js`):

- **F — refused.** The model saw you in under half the frames, or never saw hip,
  knee and ankle clearly. The gate owns the screen; no numbers travel with it.
- **C — provisional.** You left the frame while running. The camera becomes the
  headline fix, and every measurement keeps its value but loses its verdict word.
- **A/B — trusted.** The report reads normally.

Squareness is inferred, not measured, exactly as in FORM Cycling — and for the
same reason it is still **not** allowed to gate a read (`squarenessGates: false`).
It reports so it can be calibrated against real clips. **These thresholds have
not been calibrated against real running footage yet.**

## Design

**Volt on Tarmac.** Ground `#0C0E11` (near-black, cool cast — the surface is
glass, and glass only separates over a dark ground). Accent `#CDEB5A`, a
tempered high-vis lime. Gravel `#8D9490` for muted text. Chalk `#F2F4F1` ink.

One rule governs the palette: **the accent never touches the runner's body.**
Volt is chrome — nav, disc, buttons, section labels, the fix rail. A colour on
the person always means a verdict, and those are `#34D27B` in band and
`#FF9147` out, the same pair FORM Golf and FORM Cycling draw. Volt keeps its
force precisely because it is never a judgement about you. That also means the
on-video grammar is identical across the three apps, so the shared report shell
transfers with nothing to reconcile.

The mark is the FORM arc with a footstrike at its tip. On dark grounds the burst
is volt and the sole is dark; on volt grounds (the nav disc, the app icon) it
inverts — dark burst, sole punched back out — because two solid shapes on the
arc's tip merge into a blob. A chainring's teeth survive that; a footprint's
silhouette does not.

## Voice coach setup (one secret, set once)

```
supabase secrets set OPENAI_API_KEY=sk-...   # or Dashboard → Edge Functions → coach-token → Secrets
```

Optional: `COACH_MODEL` (default `gpt-realtime`) and `COACH_VOICE` (default `verse`).

Until that secret exists the function answers 503 and the app falls back to the
preview voice, naming the reason on screen. Nothing breaks; it just isn't live.

## Roadmap

- **Calibrate the capture gate** against real treadmill clips — the thresholds
  are inherited from cycling and unverified here.
- **Cadence relative to your own baseline.** The research is about a runner's
  own 5–10% change, so once there are two or more sessions the honest headline
  is the delta, not the population window.
- **Foot strike pattern** (rear/mid/forefoot) from foot angle at contact — needs
  60 fps+ to be trustworthy at all; currently not attempted rather than guessed.
- **Stride length** — needs a real distance, which is why Profile keeps height
  even though nothing today uses it.
- **Overground running** from a fixed camera, once the runner-leaves-frame case
  is handled properly.
- Contralateral pelvic drop measured as the literature defines it (peak drop on
  a single stance leg), which would let the rear view carry a cited band.

## Shared-shell contract (for FORM Golf / Cycling maintainers)

The report structure (fix card → conclusions → master video → collapsible
measured cards), the capture-gate grading, and the glass design tokens in
`css/app.css` are the shared FORM report shell. Don't fork them — lift them.
The verdict colour pair (`#34D27B` / `#FF9147`) is part of that contract; the
per-sport accent is not, and must never be used as a verdict.
