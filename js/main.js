import { currentUser, supa } from "./supa.js";
import { renderLogin } from "./pages/login.js";
import { renderHome } from "./pages/home.js";
import { renderAnalyze } from "./pages/analyze.js";
import { renderLocked } from "./pages/locked.js";
import { renderProfile } from "./pages/profile.js";

const view = document.getElementById("view");
const nav = document.getElementById("nav");

const routes = {
  login:   { render: renderLogin,  auth: false, nav: false },
  home:    { render: renderHome,   auth: true,  nav: true },
  analyze: { render: renderAnalyze,auth: true,  nav: true },
  journey: { render: (v)=>renderLocked(v,"Journey","Your long-term riding story lives here — it unlocks after your first few analyses."), auth: true, nav: true },
  drills:  { render: (v)=>renderLocked(v,"Drills","Targeted exercises matched to your fixes. Coming soon."), auth: true, nav: true },
  profile: { render: renderProfile,auth: true,  nav: true },
};

export function go(r) { location.hash = "#/" + r; }

async function route() {
  const r = (location.hash.replace(/^#\//, "") || "home").split("?")[0];
  const def = routes[r] ?? routes.home;
  const user = await currentUser();
  if (def.auth && !user) { location.hash = "#/login"; return; }
  if (!def.auth && user) { location.hash = "#/home"; return; }
  nav.classList.toggle("hidden", !def.nav);
  nav.querySelectorAll("a").forEach(a => a.classList.toggle("on", a.dataset.r === r));
  view.innerHTML = "";
  await def.render(view, user);
  view.scrollTop = 0; window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
supa.auth.onAuthStateChange(() => route());
route();
