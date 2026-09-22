# Mapa zależności i granice wykonania

Stan odczytany 2026-09-22 z bieżącego drzewa roboczego. To inwentaryzacja do T0
i podziału prac, nie wdrożenie ani potwierdzenie odbioru. Zakres: repo `video-watch`;
nie badano zainstalowanych kopii hosta, prywatnej konfiguracji ani Vaulta.
Podstawa: [TASKS](../TASKS.md), [TECHNICAL](../TECHNICAL.md) i importy kodu.

## Wejścia i bezpośredni konsumenci

Ścieżki w tabelach są względne do `agent-os-module/src/`. W wierszach `lib/`
skrót `omniwatch…` oznacza pełną nazwę pliku z rozszerzeniem `.ts`.

| Konsument `lib/omniwatch.ts` | Importowane eksporty | Granica |
|---|---|---|
| `app/api/omniwatch/jobs/route.ts` | `apiKey`, `fetchVideo`, `cachedVideo`, `watch`, `save`, `fmt`, `DEFAULT_LANG`, `PRICE_IN`, `PRICE_OUT`, `STRIP`, typ `Mode` | Analiza oraz legacy capture |
| `app/api/omniwatch/channel/route.ts` | `apiKey`, `fetchVideo`, `watch`, `save`, `logToVault`, `fmt`, `lang`, `PRICE_IN`, `PRICE_OUT` | Skan ręczny |
| `app/api/omniwatch/scout/route.ts` | `apiKey`, `fetchVideo`, `watch`, `save`, `toolsPresent`, `logToVault`, `PRICE_IN`, `PRICE_OUT` | Scout |
| `app/api/omniwatch/status/route.ts` | `apiKey`, `toolsPresent`, `cleanup`, `DEFAULT_LANG` | Status i sprzątanie wspólnego cache |
| `app/api/omniwatch/scout/setup/route.ts`, `scout/schedule/route.ts` | `run` | Integracja Hermesa |
| `app/api/omniwatch/media/[...path]/route.ts` | `videoDir`, `frameJpeg` | Wspólne odtwarzanie i klatki |
| `app/api/omniwatch/produce/route.ts`, `measure/route.ts`, `verify/route.ts`, `ground/route.ts`, `captions/route.ts` | `videoDir` | Produkcja/pomiar filmu |
| `app/api/omniwatch/recreate/route.ts` | `cacheKey`, `videoDir`, `lang` | Produkcja filmu |
| `app/api/omniwatch/clip/route.ts` | `cacheKey`, `run`, `videoDir` | Produkcja filmu |
| `lib/omniwatchChannel.ts` | `run`, `fpsFor`, `OMNI_ROOT`, `PRICE_IN`, `PRICE_OUT` | Listowanie, szacunki, zapis skanów |
| `lib/omniwatchScout.ts` | `run`, `OMNI_ROOT` | Listowanie i stan Scouta |
| `lib/omniwatchPresets.ts` | typ `Mode` | Publiczne presety |
| `lib/omniwatchGraphic.ts`, `omniwatchRecreate.ts`, `omniwatchVoice.ts` | `run`, `OMNI_ROOT` | Produkcja filmu |
| `lib/omniwatchBoardScan.ts`, `omniwatchTranscript.ts`, `omniwatchCues.ts`, `omniwatchBandScan.ts` | `run` | Pomiar/produkcja filmu |
| `lib/omniwatchClone.ts` | `videoDir`, `run` | Klonowanie |
| `lib/omniwatchAssets.ts`, `omniwatchFormats.ts`, `omniwatchTemplate.ts` | `OMNI_ROOT` | Pliki produkcji filmu |
| `lib/omniwatchCuts.ts` | `BIN_PATH` | Narzędzia produkcji filmu |
| `lib/omniwatchVerify.ts`, `omniwatchGround.ts` | `apiKey`, `run` | Weryfikacja filmu/model |

`omniwatch.ts` eksportuje ponadto `CACHE_ROOT`, `OUT_ROOT`, `VideoInfo`, `WatchStats`,
`probeDuration`, `splitParts`, `upload`, `shiftTimestamps`, `trimRunOn`, `WatchEvents`,
`vaultRoot`. Brak bezpośredniego importu produkcyjnego w tej inwentaryzacji nie jest
zgodą na usunięcie eksportu: `test/duration.test.mjs` ładuje moduł z pliku i sprawdza
`probeDuration`; konsumenci instalowanych kopii nie byli tu badani.

`omniwatchJobs.ts` eksportuje `JobState`, `Job<P,R>`, `getJob`, `startJob`, `listJobs`.
**Dokładnie trzy bezpośrednie importy w repo:** `jobs/route.ts`, `channel/route.ts`,
`scout/route.ts`; wszystkie importują `startJob` i `getJob`. Nie znaleziono osobnego
importu z route'ów produkcji ani wywołania `listJobs` poza jego definicją.
Obecne `startJob(work)` uruchamia callback w procesie Next; callback mutuje
`job.progress`, a magazyn `Map` uzupełnia `result/state/error/finishedAt`.
Nie da się przenieść takiego callbacku do osobnego procesu jako samego rekordu kolejki.

HTTP pozostaje istotną granicą zgodności:

- `OmniWatchView.tsx` używa `status`, POST/GET `jobs` i `media`.
- `ChannelScan.tsx` używa `channel` do listowania, historii, odczytu i POST/GET skanu.
- `ScoutView.tsx` używa `scout`, `scout/astros`, `scout/setup`, `scout/schedule`,
  POST/GET `jobs` dla ręcznej analizy oraz `media`.
- `hermes/omniwatch-scout.py` uruchamia POST `scout` i odpytuje `scout?job=…`;
  obecnie zależy od działającego HTTP panelu.
- POST `jobs` jawnie przyjmuje `ask`, `teardown`, `both`, **`blueprint`, `screentext`**
  i `sourceId` z cache. Nawet bez odrębnego importu Jobs z produkcji zawężenie tego
  endpointu do nowych `summary/teardown` usuwa istniejącą funkcjonalność capture.

## Zależności poprzeczne i pliki niebezpieczne

| Plik/granica | Fakt i skutek dla przydziału |
|---|---|
| `lib/omniwatch.ts` | Importuje `omniwatchI18n` i `BLUEPRINT_SCHEMA_PROMPT` z `omniwatchBlueprint`. Łączy analizę, legacy tryby capture, konfigurację, procesy, cache i zapis. T1 jest jedynym edytorem; T3/T4/T5/T6 zgłaszają potrzebne zmiany przez kontrakt. |
| `lib/omniwatchBlueprint.ts` | Wspólny silnik importuje schemat produkcji. Plik ma już lokalne zmiany drugiego projektu. T1 zachowuje działające legacy capture w adapterze; nowy rdzeń nie powinien importować całego modułu produkcji. Nie edytować schematu w ramach ekstrakcji. |
| `OMNI_ROOT`, `cacheKey`, `videoDir`, `cleanup` | Ścieżki cache i plików produkcji są współdzielone. Zmiana ID/katalogu odcina klatki i pliki; `fetchVideo` i endpoint statusu uruchamiają sprzątanie cache. Nowe zasady przechowywania wymagają mapowania legacy i ochrony aktywnych plików, a nie globalnej zmiany ścieżek. |
| `apiKey`, `run`, `BIN_PATH` | Używane przez źródła oraz produkcję. Rdzeń potrzebuje wstrzykniętego portu konfiguracji/narzędzi; istniejący eksport adaptera musi pozostać zgodny. Nie przenosić odczytów konfiguracji Hermesa/hosta do rdzenia. |
| `lib/omniwatchChannel.ts` | Importuje `scrape`/`Platform` ze Scouta i `listX`/`X_LISTING_COST_NOTE` z X; łączy listowanie z `saveScan/listScans/readScan`. Własność T1 obejmuje ten cały plik, mimo że T5 przejmuje docelowy model kolekcji. |
| `lib/omniwatchScout.ts` | Łączy `readConfig/writeConfig/readLatest/saveRun/seenUrls`, listowanie, `rank` i sprawdzanie pluginu. `scrape` uruchamia Hermesa dla źródeł Apify. T1 wydziela port źródła; T5 nie kopiuje scrapera do collections; T6 nie poprawia tego pliku obok W1. |
| `lib/omniwatchX.ts`, `omniwatchAds.ts`, `apify.ts` | X/Ads używają `runActor` z `apify.ts`; Ads także `apifyToken` i `APIFY_SETUP_HINT`. Typy pochodzą z Channel. `apify.ts` nie ma jawnego właściciela w TASKS; wyznaczyć T1 lub przekazać gotowy port bez jego edycji. |
| `jobs/route.ts`, `channel/route.ts`, `scout/route.ts`, `lib/omniwatchJobs.ts` | Muszą zmienić się spójnie w T6: enqueue danych zamiast callbacku, trwały odczyt postępu, osobny zapis/delivery. T3 wystawia API runtime; nie przejmuje route'ów. Zachować legacy dispatch dla capture albo uzgodnić jego wydzielenie z integratorem. |
| `save/logToVault` w `omniwatch.ts` | Obecnie zapis do summaries i dziennego dziennika Vaulta; nowy T4 potrzebuje indywidualnych, idempotentnych referencji. T4 tworzy nowe pliki Memory/Host, T1 zmienia delegację starego eksportu, T6 podpina potwierdzone delivery. |
| `omniwatchI18n.ts`, `omniwatchPresets.ts` | T1 jest właścicielem; korzystają API i `ChannelScan` (PRESETS). Potrzeby tekstów UI i nowych trybów z T6 wracają do T1. `channel/route.ts` importuje też `parseSkeleton` z produkcji: zachować lub odizolować legacy wynik. |
| `status/route.ts`, `media/[...path]/route.ts`, `i18n/route.ts` | Są poza listą własności T6 w TASKS, choć warunkują status, klatki i język nowego UI. Integrator powinien jawnie przydzielić ich ewentualne zmiany T6; media są wspólne z produkcją. |

## Handoffy pozwalające pracować równolegle

1. **T0 → T1/T2/T3/T4/T5/T6:** zatwierdzone entrypointy pakietu, typy
   request/result/progress/error, source capabilities, analysis/delivery/runtime ports,
   katalog danych i fixtures; root package/lock/tsconfig wyłącznie integrator.
   T3/T5/T6 mogą przygotować szkielety i testowe adaptery po tym kontrakcie;
   produkcyjne połączenie nadal czeka na zależności z TASKS.
2. **T1 → T3:** silnik przyjmujący jawny request, historię i porty oraz raportujący
   attempts/usage; brak wywoływania `startJob` i brak zapisu do prywatnego hosta w core.
   **T2 → T3:** transakcje/przejęcie pracy i protokół recovery. T3 posiada runtime;
   T6 pozostaje jedynym właścicielem starego Jobs i route'ów.
3. **T1 → T5:** kontrakt listowania ze stabilnym ID, zakresem kompletności, kursorem
   i kosztem, osobny od rankingu i zapisu legacy JSON. **T2/T3 → T5:** trwałe pozycje,
   deduplikacja, budżet i enqueue. T5 posiada collections, bez edycji source libs.
4. **T2 → T4 → T6:** kontrakt delivery/MemoryRef, następnie gotowy adapter pamięci
   hosta. Jeśli T4 i T6 dostają osobnych wykonawców mimo wspólnej roli W4 w TASKS,
   T4 zachowuje `omniwatchMemory.ts`/`omniwatchHost.ts`; T6 tylko importuje ich API.
5. **T3/T4/T5 → T6:** stabilne enqueue/query/pause/cancel/report oraz port pamięci
   i kolekcji. T6 mapuje HTTP/UI/Hermes; nie tworzy drugiej kolejki lub scrapera.
   Wczesna praca UI może używać fixtures, ale nie oznacza odbioru integracji.
6. **T1/T6 → integrator i właściciel produkcji:** lista zachowanych eksportów,
   format cache, tryby capture, HTTP response shape i test konsumentów.
   Nie kasować całego `/api/omniwatch` ani kopiować całego `src/lib` do wydania.

## Bramy startu i brakująca własność

- Obecnie brak katalogów `packages/`, `apps/` oraz root `package.json`,
  `package-lock.json`, `tsconfig.json`: T0 musi dostarczyć fundament przed odbiorem
  implementacji. Nie uruchamiano instalatorów, testów ani płatnych źródeł.
- Drzewo ma lokalne zmiany produkcji m.in. `produce/route.ts`, Blueprint, Broll,
  Clone, Compose i Produce oraz nieśledzone moduły pomiaru. Worktree utworzony z HEAD
  ich nie odziedziczy. Integrator musi przygotować uzgodnioną bazę przed rozdzieleniem
  checkoutów; nie stosować zbiorczego `git add -A` ani resetu.
- Uzupełnić przydział `apify.ts`, trzech route'ów status/media/i18n oraz testu zgodności
  eksportów. Stary `agent-os-module/test/card-source.test.mjs` pożycza TypeScript/React
  z hosta i nie ma jawnego właściciela modyfikacji w TASKS: narzędzia T0, zachowanie
  karty T6. `duration.test.mjs` również pożycza TypeScript, a test grafiki podmienia
  import `@/lib/omniwatch`; uwzględnić przy zmianie adapterów, bez przebudowy produkcji.
- T4 może tworzyć adapter i fixtures bez prywatnych danych, lecz A10/T15 wymagają
  wskazanej czystej wersji hosta i jej interfejsu wyszukiwania/modelu. Ta inwentaryzacja
  nie potwierdza dostępności takiego środowiska.
- Przed przekazaniem T6 rozstrzygnąć zgodność `blueprint/screentext/both/sourceId`.
  Sama nieobecność bezpośredniego importu Jobs z produkcji nie usuwa tej bramy.

Mapa dotyczy przygotowania podziału. Nie wprowadzono zmian w implementacji.

## Rozstrzygnięcie koordynatora po audycie

Braki własności uzupełniono: apify.ts i duration.test.mjs → A/T1; status/media/i18n
i card-source.test.mjs → C/T6. Legacy modes/sourceId zostają w adapterze/dispatchu
starego endpointu. Szczegóły [w podziale pracy](README.md#rozstrzygnięcia-audytów-do-przekazania).
Pozostałe bramy T0 i czystej instalacji są warunkami wykonania, nie pytaniami do użytkownika.
