/* Shared FORM shell pieces. The mark is the FORM arc with a chainring at its
   tip — the same shape as the home-screen icon, so the app and the thing you
   tapped to open it are recognisably one product. The arc takes currentColor;
   the ring defaults to gold so it reads on the dark app bar, and gold-ground
   surfaces override --cog to black. The starburst is gone: it was there to
   float a black cog on a dark background, and a gold ring does that on its
   own with one shape instead of two.

   The viewBox is the ink's own bounding box rather than a tidy 0 0 48 48 —
   the ring reaches above the arc's design box, and a square viewBox clipped
   the top off it in the nav disc. */

export const MARK = `<svg class="mark" viewBox="2.2 -4.5 43.8 50.8" aria-hidden="true">
  <path d="M5.5 43C7.5 20 14 7.5 24.66 7.5" fill="none" stroke="currentColor" stroke-width="6.2" stroke-linecap="round"/>
  <path class="cog" d="M30.70 -2.02 L31.66 -4.27 L36.34 -4.27 L37.30 -2.02 L38.40 -1.57 L40.67 -2.48 L43.98 0.83 L43.07 3.10 L43.52 4.20 L45.77 5.16 L45.77 9.84 L43.52 10.80 L43.07 11.90 L43.98 14.17 L40.67 17.48 L38.40 16.57 L37.30 17.02 L36.34 19.27 L31.66 19.27 L30.70 17.02 L29.60 16.57 L27.33 17.48 L24.02 14.17 L24.93 11.90 L24.48 10.80 L22.23 9.84 L22.23 5.16 L24.48 4.20 L24.93 3.10 L24.02 0.83 L27.33 -2.48 L29.60 -1.57 Z M39.64 7.50 A5.64 5.64 0 1 0 28.36 7.50 A5.64 5.64 0 1 0 39.64 7.50 Z" fill="var(--cog, #F2C230)" fill-rule="evenodd"/>
</svg>`;

export function appbar(meta = "") {
  return `<div class="appbar">
    <div class="brand">${MARK}<span class="wordmark">FORM</span> <span class="sport">Cycling</span></div>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
  </div>`;
}

/* A bottom sheet. Used where a choice needs explaining before it is made —
   connecting an outside account is the first of those, because the rider is
   about to be sent to another company's site and deserves to know what comes
   back. Closes on the backdrop, on Escape, and on its own close button. */
export function sheet(html) {
  const wrap = document.createElement("div");
  wrap.className = "sheetwrap";
  wrap.innerHTML = `<div class="sheetbg"></div>
    <div class="sheet glass" role="dialog" aria-modal="true">
      <button class="sheetx" aria-label="Close">✕</button>
      ${html}
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("open"));

  const close = () => {
    wrap.classList.remove("open");
    removeEventListener("keydown", onKey);
    setTimeout(() => wrap.remove(), 220);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  addEventListener("keydown", onKey);
  wrap.querySelector(".sheetbg").onclick = close;
  wrap.querySelector(".sheetx").onclick = close;
  return { el: wrap.querySelector(".sheet"), close };
}
