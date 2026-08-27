/* Shared FORM shell pieces. The mark is the FORM arc with the sport's badge at
   its tip: a volt burst carrying a dark footstrike — forefoot and heel, tilted
   into the direction of travel, the shape a shoe leaves on a wet belt. Cycling
   puts a chainring in the same place; Golf its own device. The arc takes
   currentColor; burst and sole keep their own colours unless a surface
   overrides them (the volt disc does, because there the accent is the ground). */

export const MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
  <path d="M6 40C8 21 17 10 30 10" fill="none" stroke="currentColor" stroke-width="5.5"/>
  <path class="burst" d="M32.00 1.50 L33.86 4.05 L36.75 2.77 L37.09 5.91 L40.23 6.25 L38.95 9.14 L41.50 11.00 L38.95 12.86 L40.23 15.75 L37.09 16.09 L36.75 19.23 L33.86 17.95 L32.00 20.50 L30.14 17.95 L27.25 19.23 L26.91 16.09 L23.77 15.75 L25.05 12.86 L22.50 11.00 L25.05 9.14 L23.77 6.25 L26.91 5.91 L27.25 2.77 L30.14 4.05 Z" fill="var(--burst, #CDEB5A)"/>
  <g class="sole" fill="var(--sole, #0C0E11)" transform="rotate(18 32 11)">
    <ellipse cx="32.6" cy="8.8" rx="3.4" ry="2.45"/>
    <ellipse cx="31.4" cy="13.3" rx="1.95" ry="1.7"/>
  </g>
</svg>`;

export function appbar(meta = "") {
  return `<div class="appbar">
    <div class="brand">${MARK}<span class="wordmark">FORM</span> <span class="sport">Running</span></div>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
  </div>`;
}
