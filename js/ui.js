/* Shared FORM shell pieces. The mark is the FORM arc with the sport's badge at
   its tip: a gold burst carrying a black chainring. Arc takes currentColor;
   burst and cog keep their own colours unless a surface overrides them. */

export const MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
  <path d="M6 40C8 21 17 10 30 10" fill="none" stroke="currentColor" stroke-width="5.5"/>
  <path class="burst" d="M32.00 1.50 L33.86 4.05 L36.75 2.77 L37.09 5.91 L40.23 6.25 L38.95 9.14 L41.50 11.00 L38.95 12.86 L40.23 15.75 L37.09 16.09 L36.75 19.23 L33.86 17.95 L32.00 20.50 L30.14 17.95 L27.25 19.23 L26.91 16.09 L23.77 15.75 L25.05 12.86 L22.50 11.00 L25.05 9.14 L23.77 6.25 L26.91 5.91 L27.25 2.77 L30.14 4.05 Z" fill="var(--burst, #F2C230)"/>
  <path class="cog" d="M30.38 6.91 L30.82 5.12 L33.18 5.12 L33.62 6.91 L34.19 7.18 L35.87 6.41 L37.33 8.25 L36.21 9.72 L36.35 10.33 L38.00 11.16 L37.47 13.46 L35.63 13.49 L35.23 13.98 L35.61 15.79 L33.49 16.81 L32.32 15.39 L31.68 15.39 L30.51 16.81 L28.39 15.79 L28.77 13.98 L28.37 13.49 L26.53 13.46 L26.00 11.16 L27.65 10.33 L27.79 9.72 L26.67 8.25 L28.13 6.41 L29.81 7.18 Z M34.00 11.00 A2.0 2.0 0 1 0 30.00 11.00 A2.0 2.0 0 1 0 34.00 11.00 Z" fill="var(--cog, #0B0B0B)" fill-rule="evenodd"/>
</svg>`;

export function appbar(meta = "") {
  return `<div class="appbar">
    <div class="brand">${MARK}<span class="wordmark">FORM</span> <span class="sport">Cycling</span></div>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
  </div>`;
}
