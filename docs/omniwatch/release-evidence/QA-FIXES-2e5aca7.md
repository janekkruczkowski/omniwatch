# OmniWatch — odbiór poprawek QA (ISSUE-001…005)

Rewizja: `codex/omniwatch-foundation`, HEAD `2e5aca7`, drzewo czyste.
Artefakt: `omniwatch-core-0.2.0.tgz`, sha256
`9fe47bf50db7243bb168f37e70d3660018dfaef18b9679a248085d9724037154`,
166 plików, 26 plików integracji Agent OS, `warnings: []`.

## Wyniki własnych testów

| Sprawdzenie | Komenda | Wynik |
|---|---|---|
| Typy | `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| Cały zestaw | `node scripts/test-all.mjs` | **235 testów, 235 PASS, 0 FAIL, 0 SKIPPED** |
| Bramka POC | `node scripts/poc/demo.mjs` | **23/23**, 5 wywołań stuba, 0 kluczy API |
| Instalator | `node --test test/install/release.test.mjs` | **15/15** |
| Beta | `node --test test/install/python-beta.test.mjs` | **14/14** |
| Regresje QA | `node --test test/install/qa-regressions.test.mjs` | **9/9** |
| Ewaluacje offline | `node test/eval/omniwatch/run-evals.mjs` | 3 PASS (E05), 4 NOT_EXECUTED |
| Koszt API | — | **0 USD** (stub) |

## Zamknięte usterki

| ID | Objaw z QA | Przyczyna | Poprawka | Dowód |
|---|---|---|---|---|
| 001/002 | `--host` → exit 2 unknown argument; panel po instalacji bez zmian | instalator nie dostarczał integracji Agent OS (tylko rdzeń) | manifest niesie 26 plików integracji; instalator je umieszcza, wykrywa konflikty z plikami projektu filmowego i wycofuje całość | instalacja na kopii hosta QA: `OmniWatchView.tsx`, `jobs/handler.ts`, `channel/handler.ts`, `status/media/i18n`, `omniwatchPanelRuntime.ts`, `omniwatch-host-worker.mjs`, `omniwatch-host-loader.mjs` na miejscu; `--host` przyjęty jako alias `--root` |
| 002b | przebudowany 0.2.0 kolidował z rozpakowanym katalogiem | katalog wydania kluczowany samą wersją | katalog `releases/<wersja>-<hash artefaktu>`; nic nie jest nadpisywane ani usuwane, brak `force-reinstall` | `install-manifest.json` → `omniwatch/releases/0.2.0-9fe47bf50db7` |
| 003 | po błędzie `missing_config` tytuł „Pobieram film…”, spinner i postęp aktywne | `fail()` wołał `finish()` zdefiniowany wewnątrz `ask()` → `finish is not defined`; brak stanu terminalnego | `stopRun()` na poziomie strony, terminalny stan błędu z tytułem, ukrytym postępem i przyciskiem retry; brak auto-reconnectu | test wykonuje **realny skrypt strony** i dostarcza ramki SSE; sprawdza zamknięcie strumienia, zdjęcie klasy `running`, zatrzymanie paska, podmianę tytułu, aktywny przycisk i retry |
| 004 | klucz ustawiony, brak `DASHSCOPE_API` → „Brak adresu API modelu analizy.” | efektywny domyślny endpoint nie docierał do runtime; `.env` nie był widziany przez runtime | `apiBaseUrlDefault` w kontrakcie konfiguracji; `effectiveEnv` (proces > plik) przekazany do runtime | test: klucz z `.env` + brak base → `DEFAULT_DASHSCOPE_HOST`; bez scalonego env klucz jest jawnie nieobecny |
| 004b | upload i model składane z jednego base | beta używała `compatible-mode/v1` dla modelu i `/api/v1/uploads` dla uploadu | `endpoints.ts`: osobne wyprowadzenie obu adresów, znormalizowany host | 6 przypadków: bare host, compatible-mode, pełny endpoint, `/v1`, inny dostawca, pusty base |
| 005 | 16 miniatur osi uszkodzonych (`naturalWidth=0`) | port tylko serwował istniejącą klatkę; brak generacji dla świeżo pobranego filmu | `ensureFrameFile` generuje klatkę ffmpeg (seek ograniczony do długości), idempotentnie | test na świeżo pobranym materiale (bez katalogu `frames/`): 200 + JPEG `ffd8…ffd9` dla 1 s, 3 s i 31 s na 16-sekundowym pliku; brak materiału → uczciwe 404 |

## Zachowane zabezpieczenia

- Zakaz nadpisania plików projektu filmowego (`AGENT_OS_PROTECTED_FILES`) — instalator zgłasza konflikt.
- Edycja użytkownika w pliku zarządzanym przez OmniWatch nadal jest konfliktem (exit 3), nic nie jest kasowane.
- Zero wywołań modelu i zero pobrań podczas migracji bety; sumy SHA starych analiz identyczne.
- Brak `--force-reinstall`, brak usuwania katalogów wydań.

## Jawne braki

| Element | Status | Jak domknąć |
|---|---|---|
| Odbiór w przeglądarce (Agent OS + standalone) | **BLOCKED dla mnie** — brak `next`/`react`/Playwright w tym checkoutcie | root uruchamia gstack QA na kopii hosta |
| E01–E04 na żywym modelu | **NOT_EXECUTED** — brak klucza i budżetu | `OMNIWATCH_API_KEY=… node test/eval/omniwatch/run-evals.mjs --live` |
| Macierz Windows/Linux | **NOT_EXECUTED** — dostępny tylko macOS | uruchomić `test/install/release.test.mjs` na tych systemach |
| A10 na czystym hoście | **NOT_EXECUTED** | QA na kopii hosta z odizolowanym Vaultem |

## Reprodukcja

```bash
cd /Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/omniwatch-autonomous
npx tsc -p tsconfig.json --noEmit
node scripts/test-all.mjs
node scripts/poc/demo.mjs
node scripts/release/build-core.mjs
node test/eval/omniwatch/run-evals.mjs
node scripts/release/install.mjs --target agent-os --root <kopia>/agent-os \
     --release-dir dist/release --data-dir <data> --skip-nav
```
