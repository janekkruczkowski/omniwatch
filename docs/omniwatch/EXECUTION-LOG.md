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
| T0 | kontrakty, narzędzia, fixture'y, baza | ukończone — `b1649f7` |
| 1 | T1 silnik/źródła, T2 SQLite | ukończone — `5d0de38` |
| 2 | T3 runtime, T4 pamięć Vault | ukończone — `1494eec` |
| 3 | T5 skany, T7 standalone | ukończone — `1bdc9a1`, `6c2917d` |
| 3b | T6 Agent OS/Hermes | w toku |
| 4 | T8 pakiet/instalator, T9 odbiór próbek | T8 gotowe (`c828a3da…`); T9 offline gotowe |

## Bramka POC (T0–T3) — PASS

`node scripts/poc/demo.mjs` → **23/23 sprawdzeń**, 5 wywołań modelu (stub), 5
indywidualnych notatek analiz, 0 użytych kluczy API. Pokrywa: summary z jednego URL,
deduplikację powtórzenia (0 nowych płatnych wywołań), streszczenie z tematem, teardown,
dopytanie z `parentTurnId`, wznowienie przez świeżo uruchomiony proces roboczy oraz brak
pozostawionego właściciela katalogu danych.

## Wykryte i naprawione błędy integracyjne

| Objaw | Przyczyna | Poprawka |
|---|---|---|
| `node --test <katalog>` nie działa na Node 22.22.3 | katalog jest traktowany jak moduł | `scripts/test-all.mjs` sam rozwija listę plików |
| Powtórka tego samego URL po rozmowie płaciła drugi raz | kontekst brał „najnowszą odpowiedź” także dla zwykłego streszczenia | historia tylko dla pytania lub wskazanego rodzica (`context.ts`) |
| CLI nie zwalniał właściciela katalogu danych | brak `releaseOwner` w ścieżce inline | `try/finally` w `commandAnalyze` |
| Recovery wskrzeszał wstrzymane/anulowane operacje | klasyfikacja `unpaid_retryable` obejmowała `budget_paused`/`failed` | jawne pominięcie decyzji użytkownika |
| Powtórzenie dostarczonej pracy kończyło się `invalid_input` | brak obsługi stanu `delivered` | odczyt istniejącego wyniku z bufora/biblioteki |
| Brak trwałych tur rozmowy | runtime nie zapisywał tur | zapis tury użytkownika i odpowiedzi po dostarczeniu |
| Fixture'y beta w złym katalogu | generator pisał `.cache`/`summaries` poza `legacy/` | poprawiony generator + regeneracja |
| `assertSafeLegacyId(".")` przechodziło | regex dopuszczał same kropki | odrzucenie `^\.+$` |

## Uczciwe ograniczenia

- Brak klucza dostawcy: wszystkie testy modelu używają stubów; ewaluacje E01–E04 są
  oznaczone `NOT_EXECUTED`, nie „zaliczone”.
- Brak zainstalowanego Next/React/Playwright w tym checkoutcie: integracja Agent OS jest
  weryfikowana modułowo, nie pełnym buildem hosta.
- `agent-os-module/src/lib/vault.ts`, `vaultGraph.ts` i `hermesApollo.ts` **nie istnieją**
  w drzewie `video-watch`; adapter pamięci powstał przeciw kontraktowi i syntetycznemu
  Vaultowi, a odbiór A10 na czystym hoście pozostaje bramką.
- Test HTTP standalone wiąże gniazdo loopback; w sandboxie bez `listen` jest raportowany
  jako SKIPPED, a z uprawnieniem przechodzi 14/14.

Szczegóły wyników, komendy i liczby przejść testów są dopisywane po odbiorze każdej fali.

## Bieżące ustalenia

- `node:sqlite` działa bez flagi na Node v22.22.3 (z ostrzeżeniem eksperymentalnym), co
  potwierdza założenie D6.
- `legacyHashId("https://example.test/video/alpha")` = `ade4dd11a0580e69`, zgodne z
  fixture'em bety z audytu `BETA-FIXTURES.md`.
- Beta dzieli materiał po `OMNI_MAX_FRAMES`, nie po `OMNI_PART_MINUTES`; fixture
  `config/legacy-minutes.env.txt` utrwala tę rozbieżność, a instrukcja migracji musi
  ją opisać.
