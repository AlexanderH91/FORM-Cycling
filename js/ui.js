/* Shared FORM shell pieces. The mark is the FORM arc running into a track: two
   lanes and a finish line seen from above, infield left open so the ground
   shows through. Cycling hangs a chainring off the same arc and Golf its own
   device, but where those sit in a badge AT the tip, this one is the place the
   arc arrives at — which is why the arc stops short. The curve is the family's,
   cut at t=0.78 by de Casteljau; only where it ends changes.

   The arc takes currentColor. The track takes --track, so a volt surface can
   flip it dark — on the nav disc and the app icon the accent is the ground. */

export const MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
  <path d="M6 40 C7.56 25.18 13.38 15.23 22.03 11.57" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round"/>
  <g class="track">
    <rect x="26.4" y="4.3" width="17.2" height="12.6" rx="6.3" fill="none" stroke="var(--track, #CDEB5A)" stroke-width="2.4"/>
    <rect x="29.1" y="7" width="11.8" height="7.2" rx="3.6" fill="none" stroke="var(--track, #CDEB5A)" stroke-width="1.2"/>
    <path d="M35 14.2 L35 15.75" stroke="var(--track, #CDEB5A)" stroke-width="1.2" stroke-linecap="round"/>
  </g>
</svg>`;

export function appbar(meta = "") {
  return `<div class="appbar">
    <div class="brand">${MARK}<span class="wordmark">FORM</span> <span class="sport">Running</span></div>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
  </div>`;
}
