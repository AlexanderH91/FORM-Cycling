/* Rides from outside FORM, and what they can honestly be made to say.
 *
 * The temptation with this data is enormous: pair a saddle change with the
 * next month's power numbers and announce that FORM found you twelve watts.
 * That claim would be unearned. A rider's power moves with fitness, sleep,
 * heat, fatigue, how hard they felt like going, and whether it was a group
 * ride — none of which FORM can see. What this module does is narrow the
 * comparison until it is as close to like-for-like as the data allows, then
 * report the difference alongside everything that could explain it other than
 * the change. It never returns the word "because". */

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2))));

/* What is worth comparing across a bike change, and why. Power is the obvious
   one and the least trustworthy on its own; watts per heartbeat is closer to
   "how hard did that cost you", which is nearer to what a fit change would
   plausibly move. */
export const METRICS = [
  { key: "avg_watts", name: "Average power", unit: "W", better: "up", floor: 3,
    of: (r) => (r.device_watts ? r.avg_watts : null),
    note: "Only from rides with a real power meter — Strava's estimate for rides without one is a model, not a measurement." },
  { key: "watts_per_bpm", name: "Watts per heartbeat", unit: "W/bpm", better: "up", floor: 0.02,
    of: (r) => (r.device_watts && r.avg_watts && r.avg_hr ? r.avg_watts / r.avg_hr : null),
    note: "Power against the heart rate it cost. Moves with fitness and with the weather, so it is a hint rather than a verdict." },
  { key: "avg_cadence", name: "Cadence", unit: "rpm", better: null, floor: 1,
    of: (r) => r.avg_cadence ?? null,
    note: "Not better high or low — but a saddle change moves it, so a shift here is a sign the change was real." },
];

/* Rides either side of a change are only comparable if they were ridden in
   comparable conditions. Indoors and outdoors are different sports for this
   purpose: no wind, no traffic lights, no descending. */
export function comparable(rides, { indoor, minMinutes = 20 }) {
  return rides.filter((r) =>
    !!r.indoor === !!indoor &&
    (r.moving_s ?? 0) >= minMinutes * 60);
}

/* One metric, before and after a change.
 *
 * `n` on each side is reported prominently and gates the whole thing: three
 * rides either way is the floor, and even then the answer is framed as an
 * observation. The difference has to clear the spread of the rides themselves
 * — the same rule the fit report uses for a band edge, for the same reason. */
export function shift(before, after, metric, minRides = 3) {
  const b = before.map(metric.of).filter((v) => Number.isFinite(v));
  const a = after.map(metric.of).filter((v) => Number.isFinite(v));
  const base = { metric: metric.key, name: metric.name, unit: metric.unit,
                 before: b.length, after: a.length };
  if (b.length < minRides || a.length < minRides)
    return { ...base, enough: false,
             short: `${Math.max(0, minRides - b.length)} more before, ${Math.max(0, minRides - a.length)} more after` };

  const bv = median(b), av = median(a);
  /* How well each side's middle is known, from its own scatter — with a floor,
     because a run of rides that happen to read identically is not proof the
     equipment and the day were identical too. Power meters disagree with each
     other by a few watts before anyone pedals. Without the floor, five rides
     all reading exactly 200 W would make any difference at all look certain. */
  const u = Math.max(Math.sqrt(sd(b) ** 2 / b.length + sd(a) ** 2 / a.length), metric.floor ?? 0);
  const delta = av - bv;
  return {
    ...base, enough: true,
    beforeValue: bv, afterValue: av, delta, u,
    // "Clear" only when the gap is bigger than the noise on both sides.
    clear: Math.abs(delta) > 1.5 * u,
    pct: bv ? (delta / bv) * 100 : null,
  };
}

/* Everything that could explain a difference other than the change itself.
   Rendered next to the numbers, never hidden behind a link — this list is the
   reason the numbers are allowed to be shown at all. */
export function confounds(before, after) {
  const out = [];
  const span = (rs) => {
    if (!rs.length) return null;
    const ts = rs.map((r) => new Date(r.start_time).getTime());
    return (Math.max(...ts) - Math.min(...ts)) / 86400000;
  };
  const days = (span(before) ?? 0) + (span(after) ?? 0);
  if (days > 42) out.push("These rides span more than six weeks, which is long enough for fitness alone to move every number here.");
  const dur = (rs) => (rs.length ? median(rs.map((r) => r.moving_s ?? 0)) / 60 : 0);
  const db = dur(before), da = dur(after);
  if (db && da && Math.abs(da - db) / Math.max(db, da) > 0.3)
    out.push(`Your rides got ${da > db ? "longer" : "shorter"} after the change (${db.toFixed(0)} to ${da.toFixed(0)} min typical), and length changes pace.`);
  const withPower = (rs) => rs.filter((r) => r.device_watts).length;
  if (withPower(before) < before.length || withPower(after) < after.length)
    out.push("Some rides had no power meter. Those are left out of the power figures rather than filled in with an estimate.");
  out.push("Nothing here accounts for sleep, heat, fatigue or how hard you felt like riding. Treat it as what happened alongside the change, not what the change did.");
  return out;
}

/* The whole comparison for one change the rider says they made. */
export function aroundChange(rides, change, { windowDays = 42, indoor = true, minRides = 3 } = {}) {
  const at = new Date(change.changed_at).getTime();
  const w = windowDays * 86400000;
  const pool = comparable(rides, { indoor });
  const before = pool.filter((r) => {
    const t = new Date(r.start_time).getTime();
    return t < at && t >= at - w;
  });
  const after = pool.filter((r) => {
    const t = new Date(r.start_time).getTime();
    return t >= at && t <= at + w;
  });
  return {
    change, indoor,
    shifts: METRICS.map((m) => shift(before, after, m, minRides)),
    confounds: confounds(before, after),
    counts: { before: before.length, after: after.length },
  };
}
