# Incydenty i planowane prace

Każdy plik `{id}.md` w tym folderze to jeden incydent albo jedne planowane prace; nazwa pliku jest adresem strony incydentu (`/incydenty/?id={id}`) i może mieć tylko małe litery, cyfry i myślniki. Plik z błędem zatrzymuje przebieg monitoringu, więc strona zostaje przy ostatnich dobrych danych, a błąd widać w Actions.

```markdown
---
title: Wolne wczytywanie Aphelion
kind: incident            # incident albo maintenance
impact: degraded          # degraded, outage albo maintenance
services: aphelion        # po przecinku: www, auth, aphelion, ephemeris, api
start: 2026-10-08T11:20+02:00
end:                      # pusty, dopóki trwa; potem czas końca
---

## investigating 2026-10-08T11:20+02:00
Listy transakcji w Aphelion wczytują się wolniej niż zwykle. Sprawdzamy przyczynę.

## identified 2026-10-08T11:45+02:00
Przyczyną jest przeciążony serwer bazy danych po nocnym imporcie. Pracujemy nad poprawką.
```

Wpisy przebiegu mają stan i czas: `investigating` (Badamy), `identified` (Przyczyna znaleziona), `monitoring` (Obserwujemy), `resolved` (Rozwiązany), a dla prac `scheduled` (Zaplanowane), `inProgress` (W toku) i `completed` (Zakończone). Przykłady są w `monitor/sample/`.
