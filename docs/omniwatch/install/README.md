# OmniWatch — instalacja, aktualizacja i cofanie (wydanie analizy, T8)

Ten dokument opisuje **wydanie wspolnej biblioteki analizy** (decyzja D4) i instalator
uzywany przez obie powloki: Agent OS oraz samodzielna aplikacje. Instalator jest jeden
(`scripts/release/install.mjs`); `agent-os-module/install.sh` to cienka powloka, ktora
go wywoluje.

Zakres tego wydania jest celowo waski:

- instalujemy **jeden, ten sam artefakt** biblioteki (`@omniwatch/core`) w obu powlokach;
  ten sam tarball niesie tez pliki powlok (`shells/agent-os/…`, `shells/standalone/…`),
  wiec instalator nigdy nie czyta plikow powloki z checkoutu,
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

Launchery standalone (`app.py`, `omniwatch.py`, `cli.mjs`) sprawdzaja obie granice tego
zakresu: Node 23 i 25+ sa odrzucane z instrukcja instalacji tak samo jak zbyt stary Node.

Wymagane narzedzia (preflight przerywa instalacje, gdy ich brak): `node` oraz `python3`
(rejestracja nawigacji w Agent OS, launcher samodzielnej aplikacji). Narzedzia
opcjonalne (`ffmpeg`, `ffprobe`, `yt-dlp`) sa raportowane z informacja, jaka zdolnosc
daja (dzielenie materialu, odczyt dlugosci, pobieranie z platform), ale ich brak nie
blokuje instalacji samej biblioteki — robi to dopiero powloka, ktora z nich korzysta.

## Instalacja w Agent OS

Jedna komenda (ta sama w `QA-HANDOFF-OMNIWATCH.md`); `<agent-os>` to katalog, ktory
**zawiera** `source/`:

```bash
# 1. Zbuduj artefakt raz (tsc + npm pack + manifest)
node scripts/release/build-core.mjs

# 2. Preflight bez zmian, potem instalacja
node scripts/release/install.mjs --target agent-os --root <agent-os> --check
node scripts/release/install.mjs --target agent-os --root <agent-os>
```

`./agent-os-module/install.sh <agent-os>` robi to samo (domyslny cel
`~/Documents/agent-os`; kolejne argumenty ida do instalatora, np. `--check`, `--json`,
`--rollback`, `--data-dir <katalog>`).

Wskazanie samej aplikacji Next (`--root <agent-os>/source`) oraz starszy zapis
`--host <agent-os>/source` (bez `--target`) sa akceptowane: cel domyslnie `agent-os`,
a sciezka `…/source` jest normalizowana do `<agent-os>` i raportowana w
`rootNormalizedFrom`. Nie ma juz szukania `source/source/…`.

Pliki integracji (trasy, UI, biblioteki panelu) pochodza z **artefaktu**
(`shells/agent-os/source/…` w tarballu). Kazdy plik jest przed zapisem porownany
z sha256 z `manifest.shellIntegration.files`; niezgodnosc (albo manifest ze starszego
buildu bez `artifactPrefix`) konczy instalacje kodem 2 bez zadnego zapisu. Plik
zmieniony w checkoutcie po buildzie nie ma wplywu na instalacje.

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

```bash
node scripts/release/install.mjs --target standalone --root ~/omniwatch-app
cd ~/omniwatch-app && uv run app.py          # http://127.0.0.1:8765
cd ~/omniwatch-app && uv run omniwatch.py <url> [-q "pytanie"] [--lang pl] [--teardown]
```

Cel moze byc pustym katalogiem albo jeszcze nie istniec (tworzony, gdy istnieje katalog
nadrzedny). Instalator zapisuje z artefaktu cala powloke: `app.py` i `omniwatch.py`
(cienkie launchery Pythona, bez wlasnej analizy), `server.mjs`, `cli.mjs`, `config.mjs`,
`legacy.mjs`, `core.mjs` oraz `static/index.html` i `static/i18n.json`. Biblioteka
trafia do `<root>/vendor/omniwatch/` (ten sam uklad `releases/`, `current`,
`install-manifest.json`, `backups/`). Dla standalone nie ma nawigacji do rejestracji.

Zainstalowana aplikacja laduje rdzen z paczki, nie z checkoutu: `core.mjs` czyta
wskaznik `vendor/omniwatch/current` i importuje zbudowany JavaScript
(`releases/<wersja>-<sha>/dist/…`), wiec uzytkownik niczego nie kompiluje. Kolejnosc:
`OMNIWATCH_CORE_ROOT` (jawny katalog rdzenia, np. przy `--install-subdir`) →
`vendor/omniwatch/current` → `../../packages/omniwatch` (tylko w checkoutcie, dla
programisty). Brak rdzenia to czytelny blad z instrukcja, bez awaryjnego silnika Pythona.

Launchery i CLI przyjmuja `OMNIWATCH_APP_ROOT` (katalog `.env`, danych bety i domyslnego
`data/`) tak samo jak serwer; rdzen zawsze pochodzi z katalogu, w ktorym lezy powloka.

### Migracja bety (katalog wydanej bety Pythona)

```bash
node scripts/release/install.mjs --target standalone --root <katalog-bety> --check   # plan: betaMigration=true
node scripts/release/install.mjs --target standalone --root <katalog-bety>
cd <katalog-bety> && uv run app.py                                                  # te same komendy i port 8765
```

Katalog z ukladem bety (`app.py` **i** `omniwatch.py`, bez wczesniejszej instalacji
OmniWatcha) jest rozpoznawany jako migracja (decyzja D2):

- `app.py`, `omniwatch.py` i `static/` bety sa kopiowane do
  `vendor/omniwatch/backups/<id>/` i zastepowane plikami z artefaktu; komendy
  `uv run app.py` / `uv run omniwatch.py <url>` oraz adres `127.0.0.1:8765` zostaja,
- `.env` (klucz i ustawienia), `summaries/`, `.cache/` i kazdy inny plik bety pozostaja
  **bajt w bajt**; nowy runtime czyta je przez adapter legacy, a swoje dane (baze
  operacji, nowe analizy, wygenerowane klatki) zapisuje do `<root>/data`,
- migracja nie pobiera filmow i nie wywoluje modelu,
- `--rollback` przywraca powloke bety bajt w bajt i usuwa pliki dodane przez instalacje
  (katalog `data/` nowego runtime zostaje - to dane uzytkownika).

Po migracji powloka nalezy do instalatora (`install-manifest.json` → `shellFiles`):
kolejna instalacja aktualizuje ja bez pytan, a plik zmieniony przez uzytkownika jest
konfliktem (kod 3). Plik w miejscu powloki w katalogu **bez** ukladu bety (np. obcy
`server.mjs`) tez jest konfliktem - instalator go nie nadpisze.

## Preflight: co jest sprawdzane przed jakimkolwiek zapisem

1. **Suma kontrolna tarballa** (`sha256`) zgodna z manifestem.
2. **Kompletnosc paczki**: kazdy plik z manifestu jest w tarballu, z ta sama dlugoscia
   i tym samym sha256; brak plikow nadmiarowych i sciezek zabronionych
   (`.env`, `node_modules`, `fixtures`, `*.sqlite`, klucze, katalogi `data/`, `test/`).
3. **Wersja Node** wg `node.requirement` z manifestu.
4. **Wymagane narzedzia** (domyslnie `node`, `python3`; nadpisywalne `--required-tools`)
   oraz raport narzedzi opcjonalnych.
5. **Sanity miejsca instalacji**: dla Agent OS katalog istnieje i ma `source/src/components/
   Sidebar.tsx`/`TopBar.tsx`; dla standalone katalog istnieje albo moze zostac utworzony;
   cel nie jest drzewem zrodlowym repozytorium. Pliki powlok z artefaktu musza miec
   sha256 z manifestu.
6. **Bramka pracy w toku (D5)**: odczyt `state.sqlite` tylko do odczytu. Wszystkie
   niezakończone i wstrzymane operacje (`pending`, `running`, `result_ready`,
   `outcome_unknown`, `failed`, `budget_paused`) maja zapisany `analysisVersion`.
   Wydanie deklaruje wspierane wersje kontraktu (`contracts.supportedAnalysisVersions`).
   Jesli choc jedna operacja ma wersje nieobslugiwana, instalacja jest **odrzucana**
   (kod wyjscia 4) — nie podstawiamy nowych promptow pod stary snapshot. Dokoncz albo
   jawnie zamknij te operacje i uruchom instalacje ponownie.

Katalogi danych: `--data-dir <katalog>` wskazuje dokladnie jeden. Bez niego bramka
sprawdza **kazdy** katalog, ktorego powloka naprawde uzywa, i ktory ma `state.sqlite`:

- standalone: `OMNIWATCH_DATA_DIR` (srodowisko albo `.env` aplikacji), domyslnie
  `<root>/data`,
- Agent OS: `OMNIWATCH_DATA_DIR`, domyslnie `~/.agentic-os/omniwatch/data` (katalog
  panelu),
- oraz starsze `<root>/.omniwatch-data` i `<root>/data/omniwatch`.

Raport `inFlight.dataDirs` wymienia sprawdzone katalogi. Brak `state.sqlite` we wszystkich
oznacza, ze nie ma pracy w toku (`inFlight.decision = "no-state"`).

## Konflikty: plik zmieniony przez uzytkownika

Instalator zna pliki, ktore sam zainstalowal (`install-manifest.json`). Przy aktualizacji:

- plik OmniWatcha, ktory uzytkownik zmienil od ostatniej instalacji, jest **zglaszany jako
  konflikt** i instalacja konczy sie przed jakimkolwiek zapisem (kod wyjscia 3),
- to samo dotyczy plikow nawigacji (`Sidebar.tsx`, `TopBar.tsx`, `hermes/page.tsx`)
  zmienionych poza instalatorem,
- nic nie jest nadpisywane po cichu. Gdy konflikt dotyczy pliku nawigacji, `--skip-nav`
  aktualizuje sama biblioteke i zostawia nawigacje bez zmian; innych konfliktow (plik
  powloki, integracji, rdzenia) `--skip-nav` nie omija - instalator mowi to wprost.

## Aktualizacja

```bash
node scripts/release/build-core.mjs          # nowe wydanie
node scripts/release/install.mjs --target agent-os --root <agent-os>
```

Przebieg: preflight (w tym bramka pracy w toku) → kopia zapasowa plikow do zastapienia →
rozpakowanie nowego wydania do katalogu tymczasowego i `rename` na `releases/<wersja>` →
edycja nawigacji → zapis `install-manifest.json` → **na koncu** podmiana wskaznika
`current` (zapis tymczasowy + `rename`). Dzieki temu przerwanie w dowolnym momencie
zostawia poprzednie wydanie jako aktywne; poprzednie katalogi `releases/` sa zachowane
nie tylko do konca procesu, ale i dla wstrzymanych operacji zaleznnych od starej paczki.

## Cofanie (rollback)

```bash
node scripts/release/install.mjs --target agent-os --root <agent-os> --rollback
# albo konkretna kopia:
node scripts/release/install.mjs --target agent-os --root <agent-os> --rollback --backup 20260922160510
```

Rollback przywraca pliki z najnowszej (lub wskazanej) kopii: `current`, manifest, pliki
nawigacji i powloki, a pliki utworzone przez cofnieta instalacje usuwa (komunikat podaje
obie liczby). **Nie dotyka katalogu danych OmniWatcha** — analizy, notatki, cache i baza
operacji pozostaja na miejscu. Dla pierwszej instalacji rollback przywraca stan sprzed
instalacji: brak wskaznika `current` i brak `install-manifest.json`, wiec nastepna
instalacja jest znow pierwsza. Id kopii sa unikalne (sufiks `-01`, `-02` przy kilku
instalacjach w tej samej sekundzie).

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

### Pobieranie z YouTube: blokady, ponowienie i (opcjonalnie) ciasteczka

yt-dlp pobiera material **zanim** cokolwiek trafi do modelu. Gdy YouTube odmowi, operacja
konczy sie jako `source_unavailable` z jednym powodem (`rate_limited_by_youtube` - HTTP 429,
`bot_check` - "Sign in to confirm you're not a bot", `private`, `unavailable`,
`geo_blocked`, `network`, `rate_limited`, `unknown`). Karta pokazuje jedno zdanie w jezyku
interfejsu i - tylko gdy serwer to potwierdza - "Nic nie zostalo wyslane do modelu i nic nie
kosztowalo". Surowy tekst yt-dlp jest schowany pod "szczegoly".

- HTTP 429: jedno ponowienie po `OMNIWATCH_YTDLP_RETRY_SECONDS` sekundach (domyslnie 30,
  maks. 120), widoczne jako "YouTube ogranicza — ponawiam za N s". Jedno na cale pobranie.
- Weryfikacja bota: **bez** ponowienia (kolejne zapytania z tego samego adresu tylko
  przedluzaja blokade). Pomaga odczekanie kilku-kilkunastu minut albo ciasteczka.

Ciasteczka przegladarki sa **domyslnie wylaczone**. Wlaczasz je swiadomie, jedna z dwoch
zmiennych (Agent OS: srodowisko procesu panelu; standalone: `.env` obok launcherow albo
srodowisko):

```
# plik cookies.txt (format Netscape) - wezsze uprawnienie, ma pierwszenstwo
OMNIWATCH_YTDLP_COOKIES=/sciezka/do/cookies.txt
# albo: yt-dlp sam czyta ciasteczka z profilu przegladarki (BROWSER[+KEYRING][:PROFIL])
OMNIWATCH_YTDLP_COOKIES_FROM_BROWSER=chrome
```

Wartosc trafia do yt-dlp jako `--cookies <plik>` albo `--cookies-from-browser <wartosc>`.
To daje yt-dlp dostep do sesji Twojego konta w przegladarce - wlacz tylko, jesli sie na to
zgadzasz. OmniWatch niczego tu nie wlacza ani nie odczytuje sam.

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
| `--target agent-os\|standalone` | powloka docelowa (wymagane, poza `--host`) |
| `--root <katalog>` | katalog docelowej powloki (wymagane); dla Agent OS `…/source` jest normalizowane |
| `--host <agent-os>/source` | alias `--target agent-os --root <agent-os>` (zgodnosc ze starszym handoffem) |
| `--check` / `--dry-run` | preflight i plan bez zadnych zmian |
| `--json` | wynik maszynowy na stdout (komunikaty czlowieka na stderr) |
| `--rollback [--backup <id>]` | cofniecie najnowszej lub wskazanej kopii |
| `--skip-nav` | aktualizacja samej biblioteki, bez rejestracji nawigacji |
| `--data-dir <katalog>` | jedyny katalog danych do bramki pracy w toku (bez niej: domyslne katalogi powloki) |
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
npm run test:install
```

Testy tworza syntetyczne kopie obu powlok w katalogu tymczasowym systemu i uzywaja
dokladnie tego samego tarballa. Obejmuja: czysta instalacje Agent OS i standalone, zla
suma kontrolna, brak narzedzia, brak pliku powloki, konflikt zmienionego pliku,
przerwanie instalacji, rollback chroniacy dane uzytkownika, wstrzymanego workera
z nieobslugiwana wersja kontraktu, zgodny snapshot zachowany bajt w bajt, dokladnie
jeden link OmniWatcha w Astrosie (takze po drugim uruchomieniu), konflikt przy braku
kotwicy Astrosa bez zadnego zapisu oraz brak zmian w plikach Directora/Blueprintu/
assemble.
