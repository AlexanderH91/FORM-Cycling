import { currentUser, supa } from "./supa.js";
import { renderLogin } from "./pages/login.js";
import { renderHome } from "./pages/home.js";
import { renderAnalyze } from "./pages/analyze.js";
import { renderLocked } from "./pages/locked.js";
import { renderProfile } from "./pages/profile.js";
import { renderCoach } from "./pages/coach.js";
import { renderJourney } from "./pages/journey.js";
import { BUILD } from "./config.js";

/* Tell the badge in index.html which build the modules actually are. The two
   strings are maintained separately on purpose: if they disagree, the browser
   is running cached JavaScript and the badge says so. */
window.FORM_BUILD_REPORT?.(BUILD);

const view = document.getElementById("view");
const nav = document.getElementById("nav");

const routes = {
  login:   { render: renderLogin,  auth: false, nav: false },
  home:    { render: renderHome,   auth: true,  nav: true },
  analyze: { render: renderAnalyze,auth: true,  nav: true },
  journey: { render: renderJourney, auth: true,  nav: true },
  // The nav and Home open the coach on your progression; a report opens it on
  // that ride. It always arrives already knowing which.
  coach:   { render: renderCoach,  auth: true,  nav: true },
  profile: { render: renderProfile,auth: true,  nav: true },
};

export function go(r) { location.hash = "#/" + r; }

// The floating nav overlaps the page, so the view has to reserve its real
// height — which changes with the phone's text size. Measure it, don't guess.
function syncNavHeight() {
  document.documentElement.style.setProperty("--nav-h", nav.offsetHeight + "px");
}
if (typeof ResizeObserver !== "undefined") new ResizeObserver(syncNavHeight).observe(nav);
addEventListener("resize", syncNavHeight);
syncNavHeight();

// Renders are async, so a second route() starting mid-flight would paint over
// the first. Only the newest one is allowed to finish.
let routeSeq = 0;
let lastUserId;
let disposePage = null;

async function route() {
  const seq = ++routeSeq;
  const r = (location.hash.replace(/^#\//, "") || "home").split("?")[0];
  const def = routes[r] ?? routes.home;
  const user = await currentUser();
  if (seq !== routeSeq) return;
  lastUserId = user?.id ?? null;
  if (def.auth && !user) { location.hash = "#/login"; return; }
  if (!def.auth && user) { location.hash = "#/home"; return; }
  nav.classList.toggle("hidden", !def.nav);
  nav.querySelectorAll("a").forEach(a => a.classList.toggle("on", a.dataset.r === r));
  if (disposePage) { try { disposePage(); } catch { /* a failed teardown must not block the next page */ } disposePage = null; }
  view.innerHTML = "";
  // A page may return a teardown function — the capture screen holds the camera.
  const dispose = await def.render(view, user);
  if (seq !== routeSeq) { try { dispose?.(); } catch {} return; }
  disposePage = typeof dispose === "function" ? dispose : null;
  syncNavHeight();
  view.scrollTop = 0; window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);

// Supabase fires this for token refreshes and user-metadata updates too, not
// just sign-in/out. Re-rendering on those threw away whatever the page was
// holding — mid-capture that meant losing the clips you had just filmed. Only
// an actual change of who is signed in is a navigation.
supa.auth.onAuthStateChange((_event, session) => {
  const id = session?.user?.id ?? null;
  if (id === lastUserId) return;
  route();
});

route();
