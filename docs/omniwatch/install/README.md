# OmniWatch — instalacja, aktualizacja i cofanie (wydanie analizy, T8)

Ten dokument opisuje **wydanie wspolnej biblioteki analizy** (decyzja D4) i instalator
uzywany przez obie powloki: Agent OS oraz samodzielna aplikacje. Instalator jest jeden
(`scripts/release/install.mjs`); `agent-os-module/install.sh` to cienka powloka, ktora
go wywoluje.

Zakres tego wydania jest celowo waski:

- instalujemy **jeden, ten sam artefakt** biblioteki (`@omniwatch/core`) w obu powlokach,
- rejestrujemy nawigacje OmniWatcha (zakladka OmniWatch i Scout),
- rejestrujemy **link z Astrosa do OmniWatcha (SPEC F12)**: czwarty chip akcji przy
  temacie Astrosa otwiera `/omniwatch?url=<film>` dla tego konkretnego filmu, wiec
  odswiezenie Astrosa nie uruchamia kolejnej platnej analizy,
- **nie** uruchamiamy patcherow Directora ani Blueprintu,
- **nie** dotykamy trasy `api/video/auto/assemble` ani zadnych innych plikow produkcji
  filmow — te zostaja w projekcie filmowym (test pilnuje, ze sa bajt w bajt nietkniete),
- **nie** kasujemy route'ow `/api/omniwatch` ani nie kopiujemy calego `src/lib`,
- **nie** dotykamy katalogu danych OmniWatcha (analizy, cache, baza operacji).

### Link Astrosa: kotwice i konflikt

Chip jest dokladany przy istniejacym przycisku `asx-act nb` w `AstrosView.tsx` i
korzysta z reguly CSS `.asx-act.seo:hover`. Rejestracja jest idempotentna: drugie
uruchomienie nic nie zmienia i **nie doklada drugiego chipu**; jesli w pliku jest juz
wiecej niz jeden chip OmniWatcha, instalator odmawia pracy i prosi o reczne
uporzadkowanie zamiast dokladac kolejny.

Jesli plik istnieje, ale kotwice zniknely (Agent OS przepisal widok Astrosa), instalator
**nie zapisuje polowicznie zmienionego pliku**: preflight uruchamia rejestrator w trybie
`--dry-run`, zglasza konflikt (kod wyjscia 3) i nie zmienia zadnego pliku — tak samo jak
przy pliku zmienionym przez uzytkownika. Brak `AstrosView.tsx` w powloce jest tylko
ostrzezeniem (starszy Agent OS bez widoku Astrosa): instalacja konczy sie, a link nie
jest rejestrowany.

## Wymagania

**Node (dokladny, przetestowany zakres): `>=22.22.3 <23 || >=24.0.0 <25`.**

Innymi slowy: linia 22 od wersji 22.22.3 (pierwsza, w ktorej `node:sqlite` dziala bez
flagi) albo linia 24. Wersje 23, 25+ i wszystkie ponizej 22.22.3 sa odrzucane przez
preflight. Manifest wydania (`dist/release/omniwatch-core-<wersja>.manifest.json`)
zawiera to wymaganie w polu `node.requirement` oraz liste przetestowanych linii
(`node.testedLines`).

Jesli `node` nie jest w `PATH`, ustaw pelna sciezke: `OMNIWATCH_NODE=/sciezka/node`.

Wymagane narzedzia (preflight przerywa instalacje, gdy ich brak): `node` oraz `python3`
(rejestracja nawigacji w Agent OS, launcher samodzielnej aplikacji). Narzedzia
opcjonalne (`ffmpeg`, `ffprobe`, `yt-dlp`) sa raportowane z informacja, jaka zdolnosc
daja (dzielenie materialu, odczyt dlugosci, pobieranie z platform), ale ich brak nie
blokuje instalacji samej biblioteki — robi to dopiero powloka, ktora z nich korzysta.

## Instalacja w Agent OS

```bash
# 1. Zbuduj artefakt raz (tsc + npm pack + manifest)
node scripts/release/build-core.mjs

# 2. Zainstaluj w kopii Agent OS
./agent-os-module/install.sh ~/Documents/agent-os
```

Domyślny cel to `~/Documents/agent-os`. Argumenty po sciezce sa przekazywane do
instalatora Node, np. `--check`, `--json`, `--rollback`, `--data-dir <katalog>`.

Wymagany uklad powloki (preflight sprawdza go i konczy sie jasnym bledem, jesli plikow
jeszcze nie ma — instalator nigdy nie udaje sukcesu):

```text
<agent-os>/source/src/components/Sidebar.tsx
<agent-os>/source/src/components/TopBar.tsx
<agent-os>/source/src/app/hermes/page.tsx   (opcjonalnie; bez niego Scout jest gorna zakladka)
```

Co powstaje w katalogu docelowym:

```text
<agent-os>/omniwatch/
  releases/<wersja>/            rozpakowana biblioteka (dist + src + package.json)
  current                       wskaznik aktywnego wydania (JSON)
  install-manifest.json         wlasnosc plikow: co zainstalowalismy i z jakim sha256
  backups/<timestamp>/          kopia kazdego pliku zastapionego lub edytowanego
```

## Instalacja samodzielnej aplikacji

Powloka standalone (T7) jest budowana w pozniejszej fali; instalator obsluguje ten sam
artefakt i ten sam kontrakt:

```bash
node scripts/release/install.mjs --target standalone --root ~/omniwatch-app
```

Wymagany uklad: `app.py`, `omniwatch.py` i katalog `static/` w katalogu docelowym.
Biblioteka trafia do `<root>/vendor/omniwatch/` (ten sam uklad `releases/`, `current`,
`install-manifest.json`, `backups/`). Dla standalone nie ma nawigacji do rejestracji.

## Preflight: co jest sprawdzane przed jakimkolwiek zapisem

1. **Suma kontrolna tarballa** (`sha256`) zgodna z manifestem.
2. **Kompletnosc paczki**: kazdy plik z manifestu jest w tarballu, z ta sama dlugoscia
   i tym samym sha256; brak plikow nadmiarowych i sciezek zabronionych
   (`.env`, `node_modules`, `fixtures`, `*.sqlite`, klucze, katalogi `data/`, `test/`).
3. **Wersja Node** wg `node.requirement` z manifestu.
4. **Wymagane narzedzia** (domyslnie `node`, `python3`; nadpisywalne `--required-tools`)
   oraz raport narzedzi opcjonalnych.
5. **Sanity miejsca instalacji**: katalog istnieje, powloka ma wymagane pliki, a cel nie
   jest drzewem zrodlowym repozytorium.
6. **Bramka pracy w toku (D5)**: odczyt `state.sqlite` tylko do odczytu. Wszystkie
   niezakończone i wstrzymane operacje (`pending`, `running`, `result_ready`,
   `outcome_unknown`, `failed`, `budget_paused`) maja zapisany `analysisVersion`.
   Wydanie deklaruje wspierane wersje kontraktu (`contracts.supportedAnalysisVersions`).
   Jesli choc jedna operacja ma wersje nieobslugiwana, instalacja jest **odrzucana**
   (kod wyjscia 4) — nie podstawiamy nowych promptow pod stary snapshot. Dokoncz albo
   jawnie zamknij te operacje i uruchom instalacje ponownie.

Katalog danych wybierany jest tak: `--data-dir <katalog>`, inaczej
`<root>/.omniwatch-data`, inaczej `<root>/data/omniwatch`. Brak `state.sqlite` oznacza,
ze nie ma pracy w toku (raportowane jawnie jako `inFlight.decision = "no-state"`).

## Konflikty: plik zmieniony przez uzytkownika

Instalator zna pliki, ktore sam zainstalowal (`install-manifest.json`). Przy aktualizacji:

- plik OmniWatcha, ktory uzytkownik zmienil od ostatniej instalacji, jest **zglaszany jako
  konflikt** i instalacja konczy sie przed jakimkolwiek zapisem (kod wyjscia 3),
- to samo dotyczy plikow nawigacji (`Sidebar.tsx`, `TopBar.tsx`, `hermes/page.tsx`)
  zmienionych poza instalatorem,
- nic nie jest nadpisywane po cichu; `--skip-nav` aktualizuje sama biblioteke i zostawia
  nawigacje bez zmian.

## Aktualizacja

```bash
node scripts/release/build-core.mjs          # nowe wydanie
./agent-os-module/install.sh ~/Documents/agent-os
```

Przebieg: preflight (w tym bramka pracy w toku) → kopia zapasowa plikow do zastapienia →
rozpakowanie nowego wydania do katalogu tymczasowego i `rename` na `releases/<wersja>` →
edycja nawigacji → zapis `install-manifest.json` → **na koncu** podmiana wskaznika
`current` (zapis tymczasowy + `rename`). Dzieki temu przerwanie w dowolnym momencie
zostawia poprzednie wydanie jako aktywne; poprzednie katalogi `releases/` sa zachowane
nie tylko do konca procesu, ale i dla wstrzymanych operacji zaleznnych od starej paczki.

## Cofanie (rollback)

```bash
./agent-os-module/install.sh ~/Documents/agent-os --rollback
# albo konkretna kopia:
node scripts/release/install.mjs --target agent-os --root ~/Documents/agent-os \
  --rollback --backup 20260922160510
```

Rollback przywraca pliki z najnowszej (lub wskazanej) kopii: `current`, manifest i pliki
nawigacji, a pliki utworzone przez cofnieta instalacje usuwa. **Nie dotyka katalogu
danych OmniWatcha** — analizy, notatki, cache i baza operacji pozostaja na miejscu.
Dla pierwszej instalacji rollback przywraca stan sprzed instalacji (brak wskaznika
`current`).

## Konfiguracja

Biblioteka nie czyta konfiguracji hosta samodzielnie: dostaje ja przez adapter
(`ConfigPort`: `dataDir`, `memoryRoot`, `language`, `modelName`, klucz API tylko
wewnatrz procesu, `maxFramesPerPart`, `cacheHours`). Dzieki temu:

- klucze i sciezki zostaja w powloce (Agent OS: konfiguracja gospodarza; standalone:
  `.env` obok launcherów),
- sekrety nie trafiaja do argv ani do `state.sqlite`; proces roboczy dostaje tylko
  niesekretna lokalizacje konfiguracji,
- srodowisko procesu ma pierwszenstwo nad plikiem `.env` (zachowanie bety).

Klucze zgodne z beta (standalone): `DASHSCOPE_API_KEY`, `DASHSCOPE_API`, `OMNI_MODEL`,
`OMNI_LANG`, `OMNI_CACHE_HOURS`, `OMNI_MAX_FRAMES`.

### Znana rozbieznosc bety: `OMNI_PART_MINUTES` nic nie robil

README i `.env.example` bety opisywaly `OMNI_PART_MINUTES=40`, ale wydany kod **nigdy
go nie czytal**. Podzial materialu szedl po klatkach: `OMNI_MAX_FRAMES=2400`
(minimalnie 300) wzgledem `dlugosc * fps`, gdzie `fps` to 10 dla materialu do 3 minut
i 2 powyzej. Nie da sie tego odtworzyc limitem w minutach, bo krotki material jest
*wiekszym* zamowieniem (1800 klatek dla 3-minutowego shorta vs 1200 dla 10-minutowej
rozmowy). W nowym rdzeniu obowiazuje tylko `maxFramesPerPart`/`OMNI_MAX_FRAMES`;
`OMNI_PART_MINUTES` pozostaje bez wplywu i jest tak opisany w migracji. Jesli miales
ustawione `OMNI_PART_MINUTES` i oczekiwales zmiany podzialu — ustaw `OMNI_MAX_FRAMES`.

## Manifest wydania

`node scripts/release/build-core.mjs` tworzy dokladnie jeden tarball i manifest:

```json
{
  "library": { "name": "@omniwatch/core", "version": "0.2.0", "declaredEntryPoints": [] },
  "artifact": { "filename": "omniwatch-core-0.2.0.tgz", "sha256": "...", "bytes": 0 },
  "node": { "requirement": ">=22.22.3 <23 || >=24.0.0 <25", "testedLines": ["22.22.3", "24"] },
  "runtimeDependencies": {},
  "contracts": {
    "contractVersion": "1.0.0",
    "analysisVersion": "analysis-v1",
    "supportedAnalysisVersions": ["analysis-v1"],
    "supportedContractVersions": ["1.0.0"]
  },
  "tools": { "node": "v22.22.3", "npm": "10.9.8", "typescript": "5.9.2" },
  "files": [{ "path": "dist/contracts/index.js", "bytes": 0, "sha256": "..." }],
  "fileCount": 0,
  "warnings": []
}
```

`warnings` jest puste albo opisuje realny brak (np. deklarowany w `package.json`
entrypoint, ktorego nie ma w paczce — dzis `dist/index.js`, bo `packages/omniwatch/src`
nie ma pliku `index.ts`). Manifest nigdy nie zawiera sekretow: build odrzuca pliki
`.env`, `node_modules`, `fixtures`, `data/`, klucze i przypisania wartosci kluczy API.

## Flagi instalatora

| Flaga | Dzialanie |
|---|---|
| `--target agent-os\|standalone` | powloka docelowa (wymagane) |
| `--root <katalog>` | katalog docelowej powloki (wymagane) |
| `--check` / `--dry-run` | preflight i plan bez zadnych zmian |
| `--json` | wynik maszynowy na stdout (komunikaty czlowieka na stderr) |
| `--rollback [--backup <id>]` | cofniecie najnowszej lub wskazanej kopii |
| `--skip-nav` | aktualizacja samej biblioteki, bez rejestracji nawigacji |
| `--data-dir <katalog>` | katalog danych do bramki pracy w toku |
| `--tarball`, `--manifest`, `--release-dir` | wskazanie artefaktu (domyslnie `dist/release`) |
| `--install-subdir <rel>` | miejsce instalacji (domyslnie `omniwatch` / `vendor/omniwatch`) |
| `--required-tools a,b` | nadpisanie listy wymaganych narzedzi (CI/testy preflight) |
| `--node-version <v>` | nadpisanie wersji Node sprawdzanej w preflight (obrazy CI/testy) |

## Kody wyjscia instalatora

| Kod | Znaczenie |
|---|---|
| 0 | sukces (lub `--check` bez zmian) |
| 2 | preflight: suma kontrolna, kompletnosc paczki, Node, narzedzia, miejsce instalacji |
| 3 | konflikt: plik uzytkownika zmieniony; nic nie nadpisano |
| 4 | praca w toku o nieobslugiwanej wersji kontraktu; aktualizacja odrzucona |
| 5 | blad zapisu/rollbacku |

## Testy instalacyjne

```bash
node --test test/install/release.test.mjs
```

Testy tworza syntetyczne kopie obu powlok w katalogu tymczasowym systemu i uzywaja
dokladnie tego samego tarballa. Obejmuja: czysta instalacje Agent OS i standalone, zla
suma kontrolna, brak narzedzia, brak pliku powloki, konflikt zmienionego pliku,
przerwanie instalacji, rollback chroniacy dane uzytkownika, wstrzymanego workera
z nieobslugiwana wersja kontraktu, zgodny snapshot zachowany bajt w bajt, dokladnie
jeden link OmniWatcha w Astrosie (takze po drugim uruchomieniu), konflikt przy braku
kotwicy Astrosa bez zadnego zapisu oraz brak zmian w plikach Directora/Blueprintu/
assemble.
