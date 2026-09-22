# OmniWatch — dziennik wykonania (koordynator)

Izolowany checkout: `/Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/omniwatch-autonomous`
Gałąź: `codex/omniwatch-foundation`. Ćwiczenie nie modyfikuje drzewa `video-watch`.

Pochodzenie plików wejściowych: `ORIGIN-INVENTORY.md` (SHA-256 każdego skopiowanego
pliku). Nie skopiowano sekretów, `.env`, `.cache/`, `summaries/`, prywatnego Vaulta
ani zależności drugiego projektu.

## Decyzje operacyjne

| # | Decyzja | Uzasadnienie |
|---|---|---|
| O1 | Baza: nowy checkout w dozwolonym workspace, nie `git worktree` z HEAD | HEAD nie zawiera niezacommitowanych dokumentów OmniWatch ani aktualnych źródeł modułu |
| O2 | `node_modules` w `.gitignore`; lock i narzędzia w repo | D4/D6: jeden artefakt biblioteki, powtarzalny build |
| O3 | Kontrakty w `packages/omniwatch/src/contracts/` są zamrożone; zmiana = decyzja koordynatora | Zlecenia A–F zależą od tych samych typów |
| O4 | Wykonawcy pracują w tym samym checkoutcie na rozłącznych plikach; nie commitują | Prosta integracja bez worktree per moduł; własność plików z TASKS |
| O5 | Testy modułów uruchamiane na źródłach `.ts` (type stripping Node 22), build `tsc` osobno | Node v22.22.3 wykonuje TS bezpośrednio; D6 nadal wymaga `tsc` + `npm pack` |
| O6 | Fixture'y beta generowane skryptem deterministycznie, z manifestem SHA-256 | BETA-FIXTURES: żadnych prywatnych danych, powtarzalność |

## Przebieg

| Fala | Zakres | Stan |
|---|---|---|
| T0 | kontrakty, narzędzia, fixture'y, baza | ukończone i zacommitowane |
| 1 | T1 silnik/źródła, T2 SQLite | uruchomione |
| 2 | T3 runtime, T4 pamięć Vault | oczekuje na T1/T2 |
| 3 | T5 skany, T6 Agent OS/Hermes, T7 standalone | oczekuje na T3/T4 |
| 4 | T8 pakiet/instalator, T9 odbiór próbek | oczekuje na T6/T7 |

Szczegóły wyników, komendy i liczby przejść testów są dopisywane po odbiorze każdej fali.

## Bieżące ustalenia

- `node:sqlite` działa bez flagi na Node v22.22.3 (z ostrzeżeniem eksperymentalnym), co
  potwierdza założenie D6.
- `legacyHashId("https://example.test/video/alpha")` = `ade4dd11a0580e69`, zgodne z
  fixture'em bety z audytu `BETA-FIXTURES.md`.
- Beta dzieli materiał po `OMNI_MAX_FRAMES`, nie po `OMNI_PART_MINUTES`; fixture
  `config/legacy-minutes.env.txt` utrwala tę rozbieżność, a instrukcja migracji musi
  ją opisać.
