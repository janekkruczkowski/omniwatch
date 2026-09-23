# OmniWatch — przekazanie do odbioru w przeglądarce (QA)

Data: 2026-09-22. Dla roota prowadzącego gstack `qa`. Ten dokument opisuje stabilną
rewizję, dokładne komendy startu, porty, konfigurację testową i realne blokady.

## Rewizja

- Repo: `/Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/omniwatch-autonomous`
- Gałąź: `codex/omniwatch-foundation`
- Drzewo `video-watch` i żywy host `/Users/janek/Documents/agent-os` **nie zostały zmienione**.
- Wszystkie testy offline: `node scripts/test-all.mjs` → 226 testów, 225 PASS, 0 FAIL,
  1 SKIPPED (test HTTP standalone bez uprawnienia `listen`; z uprawnieniem 14/14).
- Bramka POC: `node scripts/poc/demo.mjs` → 23/23, 5 wywołań stuba, 0 kluczy API.

## Co uruchomić

### 1. Standalone (wydana beta na wspólnym rdzeniu)

```bash
cd <checkout>/apps/standalone
mkdir -p /tmp/omniwatch-standalone/app && cp -R static /tmp/omniwatch-standalone/app/
cp -R <checkout>/test/fixtures/beta/legacy/. /tmp/omniwatch-standalone/app/
cp <checkout>/test/fixtures/beta/config/default.env.txt /tmp/omniwatch-standalone/app/.env
OMNIWATCH_APP_ROOT=/tmp/omniwatch-standalone/app \
OMNIWATCH_DATA_DIR=/tmp/omniwatch-standalone/data \
OMNIWATCH_PORT=8765 \
node <checkout>/apps/standalone/server.mjs      # albo: uv run app.py
```

Zweryfikowane tutaj (macOS, 2026-09-22): start wypisuje
`OmniWatch standalone: http://127.0.0.1:8765`, `GET /i18n.json` → 200,
`GET /video/SYNTHETIC01.mp4` z `Range: bytes=0-99` → **206**, 100 bajtów,
`GET /frame/SYNTHETIC01/3.jpg` → JPEG. Port pochodzi z `OMNIWATCH_PORT` (domyślnie 8765);
`server.mjs` nie przyjmuje `--port`.

- Port: `127.0.0.1:8765`, tylko loopback; Host/Origin sprawdzane przy operacjach zmieniających stan.
- Wejścia: `GET /`, `/i18n.json`, `/api/watch?url&q&lang&mode[&conversation&parent]`,
  `/video/{vid}.mp4` (Range), `/frame/{vid}/{sec}.jpg`.
- Dane testowe: `test/fixtures/beta/legacy/` (syntetyczny kanał `SYNTHETIC01` + `ade4dd11a0580e69`,
  prawdziwy 16-sekundowy MP4, klatka JPEG, dwa pliki Markdown, warianty `oss.json`).
- Tryb offline bez klucza: `/api/watch` zwraca widoczny błąd `missing_config`; to zachowanie
  jest zamierzone, nie atrapa sukcesu.
- Aby zobaczyć realną analizę, ustaw `DASHSCOPE_API_KEY` w `.env` (nie w argv) i podaj URL.

Zainstalowana aplikacja (bez checkoutu obok, rdzeń z paczki w `vendor/omniwatch/current`):

```bash
cd <checkout>
node scripts/release/build-core.mjs
node scripts/release/install.mjs --target standalone --root ~/omniwatch-app   # czysty katalog albo kopia bety
cd ~/omniwatch-app && uv run app.py            # http://127.0.0.1:8765
cd ~/omniwatch-app && uv run omniwatch.py <url>
```

Na kopii wydanej bety (katalog z `app.py` + `omniwatch.py`) ta sama komenda wykonuje
migrację: powłoka Pythona zostaje zastąpiona cienkimi launcherami (kopia w
`vendor/omniwatch/backups/`), `.env`, `.cache/` i `summaries/` zostają; `--rollback`
przywraca betę bajt w bajt. Szczegóły: `install/README.md`, „Migracja bety”.

### 2. Agent OS (integracja) — root przygotowuje środowisko

Host: `/Users/janek/Documents/agent-os/source` (Next, `npm run dev` → `127.0.0.1:3000`).
Nie instalować w żywym hoście; użyć kopii roboczej i odizolowanego `dataDir`:

Jedna komenda instalacji (ta sama w `install/README.md`): `--target agent-os --root <katalog
Agent OS>`, gdzie katalog Agent OS to ten, który **zawiera** `source/`.

```bash
cp -R /Users/janek/Documents/agent-os /tmp/agent-os-qa
cd <checkout>
node scripts/release/build-core.mjs                                   # jedna paczka + manifest
node scripts/release/install.mjs --target agent-os --root /tmp/agent-os-qa --release-dir dist/release --data-dir /tmp/omniwatch-qa-data --check   # preflight, bez zmian
node scripts/release/install.mjs --target agent-os --root /tmp/agent-os-qa --release-dir dist/release --data-dir /tmp/omniwatch-qa-data
cd /tmp/agent-os-qa/source && npm run dev
```

Starszy zapis z poprzedniej wersji tego dokumentu (`--host /tmp/agent-os-qa/source`, bez
`--target`) nadal działa jako alias: cel domyślnie `agent-os`, a ścieżka `…/source`
jest normalizowana do katalogu Agent OS (instalator wypisuje tę normalizację). Nowe
instrukcje używają wyłącznie komendy powyżej.

- Panel: `http://127.0.0.1:3000/omniwatch` (zakładka OmniWatch).
- Worker niezależny od panelu (D5) — działa na **prawdziwym** grafie hosta:

```bash
OMNIWATCH_HOST_SRC=/tmp/agent-os-qa/source/src \
OMNIWATCH_OVERLAY_SRC=<checkout>/agent-os-module/src \
OMNIWATCH_CORE=<checkout>/packages/omniwatch/src/index.ts \
node <checkout>/agent-os-module/omniwatch-host-worker.mjs --data-dir /tmp/omniwatch-qa-data --max 0
```

  Zweryfikowane tutaj: worker startuje, wypisuje `{"event":"ready"}`, przejmuje katalog
  danych i kończy się bez pozostawienia właściciela (`test/e2e/host-worker.test.mjs`, 3/3).

- Hermes (harmonogram): `agent-os-module/hermes/omniwatch-scout.py --collection <id>`
  → `node <cli> scan --collection <id> --trigger schedule --json`; raport odbierany
  najpierw z poprzedniego przebiegu. Używać odizolowanego `OMNIWATCH_DATA_DIR` i nie
  zostawiać próbnych zadań cyklicznych.

### 3. CLI (bez UI) — najszybsza ścieżka dymna

```bash
cd <checkout>
node packages/omniwatch/src/runtime/cli.ts --help
node scripts/poc/demo.mjs
```

## Konfiguracja testowa (bez sekretów)

- Wszystkie fixture'y: `test/fixtures/beta/` (`manifest.json` z SHA-256 każdego pliku).
- Zegar zamrożony: `nowSeconds = 1800000000`.
- Stub modelu (bez sieci i bez kosztu): konfiguracja `{"model":{"kind":"stub"}}`
  w `packages/omniwatch/src/runtime/poc.ts`; `callsFile` zlicza każde płatne wywołanie.
- Klucze wyłącznie ze środowiska/`.env`; nigdy w argv, logach ani `state.sqlite`.
  Fixture używa literału `fixture-not-a-secret`.

## Co QA powinno sprawdzić (zakres z docs/QA-HANDOFF.md)

1. Pojedynczy URL → domyślne **summary**; streszczenie z tematem; teardown.
2. Dalsze pytanie z kontekstem („rozwiń drugi punkt”) i izolacja filmu A→B.
3. Odświeżenie/ponowne otwarcie karty: postęp po `operationId`, brak nowej płatnej pracy.
4. Zapis i odczyt w pamięci Vaulta (`OmniWatch/Analyses/<analysisId>.md`), konflikt
   zamiast nadpisania po ręcznej edycji.
5. Skan: zakres i koszt przed startem, `partial`/`failed` odróżnione od pustego,
   ponowne uruchomienie bez duplikatów.
6. Ścieżka Hermes → raport widoczny w aplikacji; brak nowych materiałów = cisza.
7. Błędy i anulowanie: brak klucza, zły URL, pauza/anulowanie, nieznany wynik wywołania.

## Realne blokady i ograniczenia (nie ukrywać)

| Obszar | Stan |
|---|---|
| Żywy model (E01–E04) | **NIE WYKONANE** — brak klucza/budżetu; harness gotowy (`npm run eval:omniwatch`) i domyślnie raportuje `NOT_EXECUTED` |
| Build Next / Playwright | **NIE WYKONANE tutaj** — brak `next`/`react`/Playwright w tym checkoutcie; integracja Agent OS zweryfikowana modułowo (52 testy) |
| A10 na czystym hoście | do wykonania przez QA na kopii hosta; adapter pamięci napisany przeciw kontraktowi, nie przeciw żywemu Vaultowi |
| Macierz instalacji macOS/Windows/Linux | tylko macOS w tym środowisku; Windows/Linux **NIE WYKONANE** |
| Host `vault.ts` | istnieje w `/Users/janek/Documents/agent-os/source/src/lib/vault.ts`; w drzewie `video-watch` go nie ma — dlatego wcześniej raportowałem jego brak |
| Astros | link/chip przywrócony w `register-nav.py` (SPEC F12), testy 15/15 |

## Koszt API

Wszystkie testy i POC działają na stubie: **0 wywołań płatnych, 0 USD**. Realne
uruchomienie wymaga klucza użytkownika i jest osobnym, jawnym poleceniem z limitem prób.

## Zatrzymanie po odbiorze

Zatrzymać własne serwery (`server.mjs`, `npm run dev`) i usunąć katalogi tymczasowe
`/tmp/agent-os-qa`, `/tmp/omniwatch-qa-data`, chyba że Jan chce zostawić demo.
