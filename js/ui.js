/* Shared FORM shell pieces. The mark is the FORM arc BECOMING a track: the arc
   sweeps up and, at the same stroke weight, closes into an oval seen from
   above, with a lane and a finish line inside it. Cycling hangs a chainring off
   the same arc and Golf its own device — badges sitting at the tip. This one is
   not a badge: it is where the arc ends up, which is why the two share a weight
   and a colour and read as a single stroke rather than two objects.

   The curve is the family's, cut at t=0.90 by de Casteljau so its end lands on
   the oval's left edge. Arc and outer lane take currentColor; the inner lane
   and finish line take --track, so a volt surface can flip them dark — on the
   nav disc and the app icon the accent is the ground. */

export const MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
  <path d="M6 40 C7.8 22.9 15.27 12.28 26.22 10.33" fill="none" stroke="currentColor" stroke-width="4.8" stroke-linecap="round"/>
  <rect x="26.4" y="4.1" width="17.6" height="13.4" rx="6.7" fill="none" stroke="currentColor" stroke-width="4.8"/>
  <rect x="29.9" y="7.7" width="10.6" height="6.2" rx="3.1" fill="none" stroke="var(--track, #CDEB5A)" stroke-width="1.35"/>
  <path d="M35.2 13.9 L35.2 15.4" stroke="var(--track, #CDEB5A)" stroke-width="1.35" stroke-linecap="round"/>
</svg>`;

export function appbar(meta = "") {
  return `<div class="appbar">
    <div class="brand">${MARK}<span class="wordmark">FORM</span> <span class="sport">Running</span></div>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
  </div>`;
}
