/* Shared FORM shell pieces. The mark is the FORM arc ending in a crank —
   the same swing arc the other FORM apps use, with the sport at its tip. */

export const MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
  <path d="M6 40C8 21 17 10 31 10" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
  <g class="crank" fill="none" stroke-linecap="round">
    <circle cx="31" cy="10" r="5.5" stroke-width="3"/>
    <path d="M34.9 13.9 L43 22" stroke-width="4"/>
  </g>
</svg>`;

export function appbar(meta = "") {
  return `<div class="appbar">
    <div class="brand">${MARK}<span class="wordmark">FORM</span> <span class="sport">Cycling</span></div>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
  </div>`;
}
