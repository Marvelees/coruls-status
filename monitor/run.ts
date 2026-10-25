// One run of the monitoring in GitHub Actions (D9.28): it checks the services from outside, keeps the history in
// state/history.json, opens and closes the issue about an outage, which GitHub e-mails to the owner (D9.56), and writes
// the page with its data into the folder Pages publishes. Until production starts (repository variable STATUS_MODE
// other than "live") the page gets the sample data of Z9 with its strip, and the checks only reach the run's summary.
// Usage: node monitor/run.ts <built site> <output folder> [--alert-test]

import { appendFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alertAction, classify, emptyStored, parseIncident, phaseOf, record, render, SERVICES, type Check, type Incident, type ServiceKey, type Stored } from "./model.ts";

const URLS: Record<ServiceKey, string> = {
  www: "https://coruls.com/",
  auth: "https://auth.coruls.com/login",
  aphelion: "https://aphelion.coruls.com/",
  ephemeris: "https://ephemeris.coruls.com/",
  api: "https://api.ephemeris.coruls.com/health",
};
const NAMES: Record<ServiceKey, string> = { www: "Wizytówka coruls.com", auth: "Konto", aphelion: "Aphelion", ephemeris: "Ephemeris", api: "API Ephemeris" };
const STATES: Record<Check["state"], string> = { operational: "Działa", degraded: "Zakłócenia", outage: "Awaria", maintenance: "Prace serwisowe" };
const PAGE = "https://status.coruls.com";
const TIMEOUT = 10_000;
/** The reference time of the personas' sample data, Thu 8.10.2026, 12:00. */
const SAMPLE_NOW = Date.parse("2026-10-08T12:00:00+02:00");
/** Caddy's works page (deploy/caddy/pages/prace.html) carries this, so works are not an outage. */
const MAINTENANCE_PAGE = '<meta name="coruls-page" content="maintenance">';
const STATE = "state/history.json";

const time = (ms: number) => new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", day: "numeric", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(ms);

async function check(service: ServiceKey): Promise<Check> {
  const started = performance.now();
  try {
    const response = await fetch(URLS[service], { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT), headers: { "user-agent": "coruls-status (+https://github.com/Marvelees/coruls-status)" } });
    const ms = Math.round(performance.now() - started);
    const maintenancePage = response.status === 503 && (await response.text()).includes(MAINTENANCE_PAGE);
    return { service, state: classify({ status: response.status, ms, maintenancePage }), status: response.status, ms };
  } catch {
    return { service, state: "outage", status: null, ms: null };
  }
}

async function incidents(folder: string): Promise<Incident[]> {
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith(".md") && name !== "README.md");
  return Promise.all(names.map(async (name) => parseIncident(name.slice(0, -3), await readFile(join(folder, name), "utf8"))));
}

async function github(path: string, method: "POST" | "PATCH", body: unknown): Promise<{ number: number }> {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as { number: number };
}

/**
 * An issue is assigned to the repository's owner and mentions them, so GitHub e-mails it as their own ("Participating"),
 * whatever their settings for watched repositories (rekomendacja przyjęta 2026-10-25).
 */
async function openIssue(title: string, lines: string[]) {
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  return github("/issues", "POST", { title, body: [...(owner ? [`@${owner}`, ""] : []), ...lines].join("\n"), assignees: owner ? [owner] : [] });
}

const describe = (checks: Check[], services: ServiceKey[]) =>
  services.map((s) => {
    const c = checks.find((x) => x.service === s)!;
    return `- ${NAMES[s]} — ${URLS[s]} (${c.status === null ? "brak odpowiedzi" : `odpowiedź ${c.status}`})`;
  });

/** Opens, updates or closes the issue about outages and returns its number while it is open. */
async function alert(before: Stored, after: Stored, checks: Check[], now: number): Promise<number | null> {
  const action = alertAction(before, after);
  if (!action) return after.issue;
  if (action.kind === "open") {
    const lines = [`Usługi nie odpowiadają w kolejnych sprawdzeniach (${time(now)}):`, ...describe(checks, action.services), "", `Zgłoszenie zamknie się samo, gdy wszystkie usługi znów zadziałają. Strona statusu: ${PAGE}`];
    return (await openIssue(`Awaria: ${action.services.map((s) => NAMES[s]).join(", ")}`, lines)).number;
  }
  if (action.kind === "update") {
    await github(`/issues/${after.issue}/comments`, "POST", { body: [`Teraz nie odpowiadają (${time(now)}):`, ...describe(checks, action.services)].join("\n") });
    return after.issue;
  }
  await github(`/issues/${after.issue}/comments`, "POST", { body: `Wszystkie usługi działają (${time(now)}).` });
  await github(`/issues/${after.issue}`, "PATCH", { state: "closed" });
  return null;
}

/** The test of the e-mail path the owner asked for: an issue opened and closed at once (rekomendacja przyjęta 2026-10-25). */
async function alertTest(now: number) {
  const issue = await openIssue("Test powiadomienia ze strony statusu", [
    `Zgłoszenie testowe z ręcznego przebiegu monitoringu (${time(now)}). Jeśli przyszedł o nim e-mail, powiadomienia o awariach działają. Zgłoszenie zamyka się od razu.`,
  ]);
  await github(`/issues/${issue.number}`, "PATCH", { state: "closed" });
  console.log(`test issue #${issue.number} opened and closed`);
}

const [site, out] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (!site || !out) throw new Error("usage: node monitor/run.ts <built site> <output folder> [--alert-test]");
const live = process.env.STATUS_MODE === "live";
const now = Date.now();
const checks = await Promise.all(SERVICES.map(check));

const report = [`## Sprawdzenie ${time(now)}${live ? "" : " (dane przykładowe na stronie)"}`, "", "| Usługa | Stan | Odpowiedź | Czas |", "|---|---|---|---|", ...checks.map((c) => `| ${NAMES[c.service]} | ${STATES[c.state]} | ${c.status ?? "brak"} | ${c.ms === null ? "—" : `${c.ms} ms`} |`)].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

let list: Incident[];
let files: ReturnType<typeof render>;
let at: number;
if (live) {
  list = await incidents("incidents");
  const before: Stored = JSON.parse(await readFile(STATE, "utf8").catch(() => JSON.stringify(emptyStored())));
  const after = record(before, checks, list, now);
  after.issue = await alert(before, after, checks, now);
  await mkdir("state", { recursive: true });
  await writeFile(STATE, `${JSON.stringify(after, null, 2)}\n`);
  at = now;
  files = render(list, after, at, false);
} else {
  list = await incidents("monitor/sample");
  at = SAMPLE_NOW;
  files = render(list, null, at, true);
}
if (process.argv.includes("--alert-test")) await alertTest(now);

await cp(site, out, { recursive: true });
await mkdir(join(out, "data", "incidents"), { recursive: true });
await writeFile(join(out, "data", "summary.json"), JSON.stringify(files.summary));
await writeFile(join(out, "data", "history.json"), JSON.stringify(files.history));
for (const incident of list) await writeFile(join(out, "data", "incidents", `${incident.id}.json`), JSON.stringify({ ...incident, phase: phaseOf(incident, at) }));
