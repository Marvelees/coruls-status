// The data of the status page (Z9, D4.5, D9.28): services and their states, incidents and planned works
// written as Markdown, what the monitoring keeps between runs and the files the page reads. Pure
// functions without dependencies, so GitHub Actions runs them with Node 24 as they are.

export const SERVICES = ["www", "auth", "aphelion", "ephemeris", "api"] as const;
export type ServiceKey = (typeof SERVICES)[number];
export type ServiceState = "operational" | "degraded" | "outage" | "maintenance";
export type EntryState = "investigating" | "identified" | "monitoring" | "resolved" | "scheduled" | "inProgress" | "completed";
export type Phase = "ongoing" | "planned" | "resolved" | "completed";
export type IncidentEntry = { state: EntryState; at: string; text: string };
export type Incident = {
  id: string;
  title: string;
  kind: "incident" | "maintenance";
  impact: Exclude<ServiceState, "operational">;
  services: ServiceKey[];
  start: string;
  /** Null while it lasts. */
  end: string | null;
  /** Oldest first. */
  entries: IncidentEntry[];
};
/** An incident as the page gets it, with where it stood when the data were made. */
export type PublishedIncident = Incident & { phase: Phase };
/** A day of the 90 is „Brak danych” before the monitoring's first check (Z9). */
export type DayState = ServiceState | "noData";
export type DayStates = { date: string; states: Record<ServiceKey, DayState> };

/** data/summary.json (getStatusSummary). */
export type Summary = {
  updatedAt: string;
  /** Sample data until the monitoring starts with production (D9.28): the page shows a strip about it. */
  sample: boolean;
  overall: ServiceState;
  services: { key: ServiceKey; state: ServiceState; availability: number }[];
  active: PublishedIncident[];
  planned: PublishedIncident[];
};
/** data/history.json (getStatusHistory): 90 days and the incidents that ended in them. */
export type History = { updatedAt: string; days: DayStates[]; incidents: PublishedIncident[] };

/** What the repository keeps between runs of the monitoring (state/history.json). */
export type Stored = {
  /** Warsaw day of the last run; it changes once a day, which keeps the repository active for the schedule. */
  checkedOn: string;
  /** Warsaw day of the first run; the days before it have no data. */
  since: string;
  /** Minutes of each problem state per day and service; days without problems are absent. */
  days: Record<string, Partial<Record<ServiceKey, Partial<Record<Exclude<ServiceState, "operational">, number>>>>>;
  /** The state of the last check and how many checks in a row found an outage. */
  services: Record<ServiceKey, { state: ServiceState; failures: number }>;
  /** The open issue about an outage (D9.56). */
  issue: number | null;
};
/** One check of one service. */
export type Check = { service: ServiceKey; state: ServiceState; status: number | null; ms: number | null };

export const DAYS = 90;
/** Minutes between scheduled runs; every check stands for this much time. */
export const INTERVAL = 5;
/** Checks in a row that make an outage worth an issue, so one lost request wakes nobody. */
export const ALERT_AFTER = 2;
/** A check slower than this finds disruptions. */
export const SLOW_MS = 3000;

const SEVERITY: Record<ServiceState, number> = { operational: 0, maintenance: 1, degraded: 2, outage: 3 };
export const worst = (states: ServiceState[]) => states.reduce<ServiceState>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "operational");

const WARSAW = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function wall(ms: number) {
  const p = Object.fromEntries(WARSAW.formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, ms: Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!) };
}
/** The Warsaw calendar day of an instant (YYYY-MM-DD). */
export const warsawDate = (ms: number) => wall(ms).date;
/** Midnight in Warsaw at the start of `date`; Poland changes its clocks at 2:00 or 3:00, never at midnight. */
export function warsawMidnight(date: string) {
  const utc = Date.parse(`${date}T00:00:00Z`);
  return utc - (wall(utc).ms - utc);
}
/** The `count` Warsaw days that end with the day of `now`, oldest first. */
export function lastDays(now: number, count = DAYS) {
  const today = warsawMidnight(warsawDate(now));
  return Array.from({ length: count }, (_, i) => warsawDate(today - (count - 1 - i) * 86_400_000 + 12 * 3_600_000));
}

const started = (i: Incident, now: number) => Date.parse(i.start) <= now;
const ongoing = (i: Incident, now: number) => started(i, now) && (i.end === null || Date.parse(i.end) > now);

/** Where an incident or works stand at `now`: „Trwa”, „Zaplanowane”, „Rozwiązany” or „Zakończone”. */
export function phaseOf(incident: Incident, now: number): Phase {
  if (ongoing(incident, now)) return "ongoing";
  if (!started(incident, now)) return "planned";
  return incident.kind === "maintenance" ? "completed" : "resolved";
}

const publish = (incident: Incident, now: number): PublishedIncident => ({ ...incident, phase: phaseOf(incident, now) });

/** Is a service under declared works at `now`? Then a failed check counts as works, not as an outage. */
export const underMaintenance = (incidents: Incident[], service: ServiceKey, now: number) =>
  incidents.some((i) => i.kind === "maintenance" && i.services.includes(service) && ongoing(i, now));

/** One check's state from the answer: no answer or an error is an outage, Caddy's works page is works (D9.29), a slow answer disruptions. */
export function classify(answer: { status: number | null; ms: number | null; maintenancePage: boolean }): ServiceState {
  if (answer.status === null || answer.ms === null) return "outage";
  if (answer.status === 503 && answer.maintenancePage) return "maintenance";
  if (answer.status >= 400) return "outage";
  return answer.ms > SLOW_MS ? "degraded" : "operational";
}

export const emptyStored = (): Stored => ({
  checkedOn: "",
  since: "",
  days: {},
  services: Object.fromEntries(SERVICES.map((s) => [s, { state: "operational", failures: 0 }])) as Stored["services"],
  issue: null,
});

/** The day of the first check; a history kept before it was recorded starts at its oldest day. */
const sinceOf = (stored: Stored, today: string) => stored.since || [stored.checkedOn, ...Object.keys(stored.days)].filter(Boolean).sort()[0] || today;

/** The stored state after one round of checks at `now`: minutes of problems per day, the last states and failures in a row; days past the 90 drop out. */
export function record(stored: Stored, checks: Check[], incidents: Incident[], now: number): Stored {
  const today = warsawDate(now);
  const keep = new Set(lastDays(now));
  const days = Object.fromEntries(Object.entries(stored.days).filter(([date]) => keep.has(date)));
  const services = { ...stored.services };
  for (const check of checks) {
    const state = check.state === "outage" && underMaintenance(incidents, check.service, now) ? "maintenance" : check.state;
    services[check.service] = { state, failures: state === "outage" ? stored.services[check.service].failures + 1 : 0 };
    if (state === "operational") continue;
    const day = { ...days[today] };
    day[check.service] = { ...day[check.service], [state]: (day[check.service]?.[state] ?? 0) + INTERVAL };
    days[today] = day;
  }
  return { ...stored, checkedOn: today, since: sinceOf(stored, today), days, services };
}

/** The services whose outage has lasted long enough for an issue. */
export const failing = (stored: Stored) => SERVICES.filter((s) => stored.services[s].failures >= ALERT_AFTER);

/** What to do with the issue about outages: open one, comment when the failing services change, close it when all work again. */
export function alertAction(before: Stored, after: Stored): { kind: "open" | "update"; services: ServiceKey[] } | { kind: "close" } | null {
  const now = failing(after);
  if (now.length > 0 && after.issue === null) return { kind: "open", services: now };
  if (now.length === 0 && after.issue !== null) return { kind: "close" };
  if (now.length > 0 && failing(before).join() !== now.join()) return { kind: "update", services: now };
  return null;
}

/** Share of `days` days without an outage, in per cent with two decimals, from outage minutes. */
const share = (minutes: number, days: number) => Math.floor((1 - minutes / (days * 24 * 60)) * 10_000) / 100;

/**
 * The files of the page at `now`. With stored checks (production) a day's state is the worst of its checks and of the
 * incidents over it, the days before the first check have no data, and the availability comes from the checks' outage
 * minutes over the checked days; without them (sample data) both come from the incidents over all 90 days, as in the
 * prototype.
 */
export function render(incidents: Incident[], stored: Stored | null, now: number, sample: boolean): { summary: Summary; history: History } {
  const updatedAt = new Date(now).toISOString();
  const seen = incidents.filter((i) => started(i, now));
  const since = stored && sinceOf(stored, warsawDate(now));
  const days = lastDays(now).map((date): DayStates => {
    if (since && date < since) return { date, states: Object.fromEntries(SERVICES.map((s) => [s, "noData"])) as Record<ServiceKey, DayState> };
    const from = warsawMidnight(date);
    const to = from + 86_400_000;
    const over = seen.filter((i) => Date.parse(i.start) < to && (i.end === null ? now : Date.parse(i.end)) > from);
    const states = Object.fromEntries(
      SERVICES.map((s) => {
        const checked = Object.entries(stored?.days[date]?.[s] ?? {})
          .filter(([, minutes]) => (minutes ?? 0) > 0)
          .map(([state]) => state as ServiceState);
        return [s, worst([...over.filter((i) => i.services.includes(s)).map((i) => i.impact), ...checked])];
      }),
    ) as Record<ServiceKey, ServiceState>;
    return { date, states };
  });
  const active = seen.filter((i) => ongoing(i, now));
  const checkedDays = since ? days.filter((d) => d.date >= since).length : DAYS;
  const availability = (s: ServiceKey) =>
    share(
      stored
        ? Object.values(stored.days).reduce((sum, day) => sum + (day[s]?.outage ?? 0), 0)
        : seen.filter((i) => i.impact === "outage" && i.services.includes(s)).reduce((sum, i) => sum + ((i.end === null ? now : Date.parse(i.end)) - Date.parse(i.start)) / 60_000, 0),
      checkedDays,
    );
  const services = SERVICES.map((key) => ({
    key,
    state: worst([...active.filter((i) => i.services.includes(key)).map((i) => i.impact), stored?.services[key].state ?? "operational"]),
    availability: availability(key),
  }));
  const first = warsawMidnight(days[0]!.date);
  return {
    summary: {
      updatedAt,
      sample,
      overall: worst(services.map((s) => s.state)),
      services,
      active: active.map((i) => publish(i, now)),
      planned: incidents.filter((i) => i.kind === "maintenance" && !started(i, now)).map((i) => publish(i, now)),
    },
    history: {
      updatedAt,
      days,
      incidents: seen
        .filter((i) => !ongoing(i, now) && Date.parse(i.start) >= first)
        .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
        .map((i) => publish(i, now)),
    },
  };
}

const KINDS = ["incident", "maintenance"];
const IMPACTS = ["degraded", "outage", "maintenance"];
const ENTRY_STATES = ["investigating", "identified", "monitoring", "resolved", "scheduled", "inProgress", "completed"];
const isTime = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));

/**
 * An incident or planned works from its Markdown file (`incidents/{id}.md`): a front matter of `key: value` lines
 * (title, kind, impact, services, start, end) and an entry per `## {state} {time}` heading with its text below.
 * A file against these rules stops the run, so the page keeps its last good data.
 */
export function parseIncident(id: string, text: string): Incident {
  const fail = (why: string): never => {
    throw new Error(`incidents/${id}.md: ${why}`);
  };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) fail("the file name may have only lowercase letters, digits and hyphens");
  const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) fail("no front matter between --- lines");
  const fields = Object.fromEntries(
    match![1]!
      .split("\n")
      .map((line) => line.replace(/\s+#.*$/, "").trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(":");
        if (at < 0) fail(`not a "key: value" line: ${line}`);
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  const title = fields.title || fail("no title");
  const kind = fields.kind ?? "";
  if (!KINDS.includes(kind)) fail(`kind is ${KINDS.join(" or ")}`);
  const impact = fields.impact ?? "";
  if (!IMPACTS.includes(impact)) fail(`impact is ${IMPACTS.join(", ")}`);
  const services = (fields.services ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (services.length === 0 || services.some((s) => !(SERVICES as readonly string[]).includes(s))) fail(`services are a comma-separated list of ${SERVICES.join(", ")}`);
  const start = fields.start ?? "";
  if (!isTime(start)) fail("start is a time with its offset, such as 2026-10-08T11:20+02:00");
  const end = fields.end || null;
  if (end !== null && (!isTime(end) || Date.parse(end) < Date.parse(start))) fail("end is empty or a time with its offset after the start");
  const entries = match![2]!
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const [heading = "", ...lines] = block.split("\n");
      const [state = "", at = ""] = heading.trim().split(/\s+/);
      if (!ENTRY_STATES.includes(state)) fail(`an entry's state is one of ${ENTRY_STATES.join(", ")}: ## ${heading}`);
      if (!isTime(at)) fail(`an entry needs its time: ## ${heading}`);
      const body = lines.join(" ").replace(/\s+/g, " ").trim();
      if (!body) fail(`the entry ## ${heading} has no text`);
      return { state: state as EntryState, at, text: body };
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (entries.length === 0) fail("no entries (## {state} {time})");
  return { id, title, kind: kind as Incident["kind"], impact: impact as Incident["impact"], services: services as ServiceKey[], start, end, entries };
}
