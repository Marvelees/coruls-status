# Status usług Coruls

Strona statusu usług Coruls i monitoring, który ją zasila. Repozytorium publikuje główne repozytorium Coruls (`apps/status`, skrypt `scripts/publish.sh`): nie zmieniaj ręcznie `site/`, `monitor/` ani workflow, bo następna publikacja je nadpisze.

| Folder | Zawartość |
|---|---|
| `site/` | zbudowana strona (eksport statyczny Next.js) |
| `monitor/` | przebieg monitoringu (`run.ts`) i jego model (`model.ts`); `monitor/sample/` to dane przykładowe z ekranu Z9 |
| `incidents/` | incydenty i planowane prace w Markdownie — format opisuje `incidents/README.md` |
| `state/` | historia sprawdzeń z 90 dni; pojawia się po starcie produkcji |
| `.github/workflows/monitor.yml` | workflow „Status”: sprawdza usługi, zapisuje historię, zakłada zgłoszenia o awariach i publikuje stronę na GitHub Pages |

## Przed startem produkcji

Workflow uruchamia się ręcznie (Actions → Status → Run workflow), a strona pokazuje dane przykładowe z paskiem „Dane przykładowe”. Opcja „Test powiadomienia” zakłada i od razu zamyka zgłoszenie testowe, żeby sprawdzić e-mail od GitHuba.

## Po starcie produkcji

Workflow działa co 5 minut. Usługa, która dwa razy z rzędu nie odpowiada, otwiera zgłoszenie „Awaria: …” przypisane do właściciela repozytorium, o którym GitHub powiadamia e-mailem; zgłoszenie zamyka się samo, gdy wszystkie usługi znów działają. Odpowiedź wolniejsza niż 3 s to zakłócenia, a strona prac serwisowych Caddy i zapowiedziane prace to prace serwisowe.
