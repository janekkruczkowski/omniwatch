# Zlecenie: fixture’y i kontrakty migracji bety

Status: przygotowane zlecenie, 2026-09-22. Nie utworzono fixture’ów, nie uruchomiono
testów, instalatorów ani modelu. Ten dokument jest jedynym plikiem zmienianym w tym
odcinku. Zatwierdzony zakres: [PLAN — D2](../PLAN.md#kompatybilność-bety-pythona--wykonanie-decyzji-d2),
[TASKS](../TASKS.md), [TEST-PLAN — T17](../TEST-PLAN.md).

## Własność i moment rozpoczęcia

| Zadanie | Właściciel / pliki | Co można przygotować niezależnie | Zależność odbioru |
|---|---|---|---|
| T0 | W0: `test/fixtures/beta/`, kontrakty i root tooling | Syntetyczne dane, manifesty SHA-256, oczekiwane SSE, macierze CLI/konfiguracji i specyfikacje asercji poniżej | Brak zależności od biblioteki; integrator zatwierdza zamrożony format |
| T7 | W6: `apps/standalone/`, `app.py`, `omniwatch.py`, `static/`, `test/install/python-beta.test.mjs` | Projekt harnessu i przypadki kontraktowe korzystające z fixture’ów T0; stuby transportu bez implementowania silnika | T1 + T2 + T3; rzeczywisty adapter, launchery i migracja dopiero przeciw wspólnemu runtime |
| T8 | W5: `scripts/release/`, instalator, `docs/omniwatch/install/`, `test/install/release.test.mjs`, CI | Macierz preflight/backup/rollback i struktura dowodów pakowania po T0 | Pełny odbiór T6 + T7, ten sam tarball rdzenia w obu aplikacjach |

W0 pozostaje jedynym właścicielem root package/lock i kontraktów. W6 nie edytuje
instalatora W5 ani biblioteki W1/W2/W3. Inni wykonawcy pracują w tym repo: nie cofać
ich zmian, nie kopiować prywatnej instalacji i nie używać `git add -A`. Nazwy plików
testowych poza `test/install/python-beta.test.mjs` wymagają przydzielenia własności
przez integratora; poniższe nazwy przypadków mogą być podtestami tego jednego pliku.

## Zasady danych i harnessu

- Wszystkie dane powstają od zera. Bez czytania rzeczywistego `.env`, `.cache/`,
  `summaries/`, Vaulta, kluczy Hermesa lub katalogów użytkownika. Fake konfigurację
  przechowywać jako `config/*.env.txt`; dopiero w katalogu tymczasowym nazwać `.env`.
- Nie importować produkcyjnego `omniwatch.py` z katalogu repo w harnessie: import
  odczytuje `.env`. Stare entrypointy kopiować do syntetycznej instalacji albo
  uruchamiać po przygotowaniu jawnie odizolowanego katalogu danych/konfiguracji.
- Zamrożony zegar: `nowSeconds = 1800000000`, `nowMilliseconds = 1800000000000`.
  Mtime ustawia harness po skopiowaniu; nie polegać na czasie checkoutu Git.
- Każdy test dostaje osobną kopię fixture’u. Środowisko procesu jest jawnie
  zbudowane; brak dziedziczenia kluczy i `AGENT_OS_SOURCE`. Sieć jest zabroniona;
  stub modelu, uploadu, downloadera i resolvera zlicza wywołania i może rzucać
  błąd przy każdej próbie. Nie instalować zależności jako efektu testu.
- `uv run` w odbiorze jest trybem offline z przygotowanymi wcześniej zależnościami.
  Osobno sprawdzić dokładne komendy użytkownika w gotowym środowisku T8. Przeglądarka
  dostaje lokalny renderer Markdown; żądania CDN/fontów są przechwycone lub
  zablokowane, aby test starego HTML nie korzystał niejawnie z sieci.
- Pliki MP4/JPEG mają pochodzić z własnej miniatury testowej (jednokolorowe klatki,
  krótki ton, bez ludzi i cudzych materiałów). T0 zapisuje raz gotowe pliki z SHA-256
  oraz receptą utworzenia. Kontrakt zakresów HTTP używa prawdziwego małego MP4;
  plik tekstowy z rozszerzeniem `.mp4` nie zalicza odtwarzania/seeking.

## Inwentarz do utworzenia w `test/fixtures/beta/`

To docelowe nazwy, nie lista już istniejących plików. Manifest opisuje każdy wariant,
źródło syntetyczne, wymagane mtime, SHA-256 i oczekiwany wynik. SHA oblicza się przy
utworzeniu plików i zapisuje jawnie; nie generuje się oczekiwanego SHA przez ponowne
odczytanie zmienionego pliku po migracji.

| Plik / katalog | Dokładna zawartość lub wariant | Oczekiwany wynik |
|---|---|---|
| `manifest.json`, `README.md` | `fixtureVersion: 1`, zegar powyżej, lista względnych ścieżek, rozmiarów, SHA-256 i mtime; recepty mediów, brak sekretów | Powtarzalne kopie i porównania, żadnej zależności od prywatnej maszyny |
| `config/default.env.txt` | `DASHSCOPE_API_KEY=fixture-not-a-secret`, `DASHSCOPE_API=https://provider.example.invalid`, `OMNI_MODEL=fixture-omni`, `OMNI_LANG=pl`, `OMNI_CACHE_HOURS=48`, `OMNI_MAX_FRAMES=2400` (po jednym na linię) | Odczyt obok launcherów, także gdy CWD jest inny; żadne wywołanie hosta z tej konfiguracji |
| `config/precedence.json` | Plik powyżej + env procesu `OMNI_LANG=en`, `OMNI_MODEL=fixture-process`, `DASHSCOPE_API_KEY=fixture-process-key` | Te trzy wartości z procesu wygrywają; pozostałe z pliku; brak sekretów w logach |
| `config/legacy-minutes.env.txt` | Jak default, ale bez `OMNI_MAX_FRAMES`, z `OMNI_PART_MINUTES=40` | Udokumentowany brak wpływu minutes w becie; nie udawać dotychczasowego wsparcia tej opcji |
| `config/missing-key.env.txt` | Tylko `OMNI_LANG=en` | Czytelny błąd konfiguracji przed downloaderem/uploadem/modelem; migracja i odczyt starych analiz nadal działają |
| `ids.json` | YouTube watch/shorts/live/embed/youtu.be z ID `SYNTHETIC01`; `https://example.test/video/alpha`, wariant `?x=1` i `#clip` | YouTube → `SYNTHETIC01`; trzy nie-YouTube → `ade4dd11a0580e69` (SHA-1 pierwsze 16 znaków); mapowanie zachowuje legacy nazwę |
| `legacy/.cache/SYNTHETIC01/info.json` | `{"id":"SYNTHETIC01","title":"Fixture A — ekran","channel":"Fixture Channel","uploader":"Fallback A","duration":16,"extractor_key":"Youtube"}` | `channel` ma pierwszeństwo; duration `0:16`; oryginalny JSON bez zmian |
| `legacy/.cache/ade4dd11a0580e69/info.json` | `{"id":"ade4dd11a0580e69","title":"Fixture B — dźwięk","channel":null,"uploader":"Fixture Uploader","duration":16,"extractor_key":"Generic"}` | Normalizacja do `channel=Fixture Uploader`, `extractor=Generic`; oryginalne `uploader`/`extractor_key` zachowane |
| `legacy/.cache/<oba-id>/source.mp4` | Własny 16-sekundowy mały film; każdemu ID przypisać odróżnialną kolorystykę i osobny SHA | Odczyt przez legacy URL, działające Range/seeking; test A→B wykrywa podmianę źródła |
| `legacy/.cache/SYNTHETIC01/frames/3.jpg` | Własna istniejąca klatka A | GET oddaje dokładne bajty; bez uruchamiania ffmpeg |
| `legacy/.cache/SYNTHETIC01/part_2_0.mp4`, `part_2_1.mp4` | Własne fragmenty; sam test migracji nie interpretuje ich jako aktywny plan cięcia 16 s | Pliki i nazwy nietknięte podczas migracji; nie analizować ich automatycznie |
| `oss/fresh.json` | `{"source.mp4":{"url":"oss://fixture/source.mp4","at":1799999940}}` | Wiek 60 s: ważny legacy upload, `reused=true` w zleconej analizie ze stubem |
| `oss/expired.json` | To samo z `at=1799830800` | Dokładnie 47 h: nieważny (`age < OSS_TTL` jest warunkiem ważności); odczyt/migracja nie odświeża go |
| `oss/invalid.json`, `oss/malformed.txt` | Pierwszy: `at:"not-a-time"`; drugi dosłownie `{broken` | Diagnostyka wpisu, brak uznania uploadu za ważny; brak utraty Markdown i brak uploadu podczas migracji |
| `oss/future.json` | To samo z `at=1800000060` | Docelowo nie traktować błędnego przyszłego czasu jako świeżości; jawna poprawka wobec starego warunku wieku |
| `legacy/summaries/SYNTHETIC01.md` | Format poniżej: summary EN, pytanie PL i teardown PL dopisane do jednego pliku, stałe daty | Odczyt całego pliku byte-for-byte; brak wymogu rekonstrukcji każdej rozmowy |
| `legacy/summaries/ade4dd11a0580e69.md` | Własny nagłówek użytkownika, CRLF, polskie znaki, brak końcowego newline; URL źródła | Zachowanie bajtów mimo nietypowego formatowania i błędów cache |
| `variants.json` | `missing-source`, `missing-info`, `malformed-info`, `missing-oss`, `orphan-summary`, `expired-local-cache`, `incomplete-release` | Harness tworzy warianty tylko z syntetycznej kopii; analizy zawsze zachowane; uszkodzona instalacja zatrzymuje przełączenie |
| `sse/single.events.json`, `sse/multipart.events.json`, `sse/error.events.json` | Tablice `{event,data}` według kontraktu niżej; wire serializer dodaje rzeczywiste LF | Golden kontraktu, bez zależności od modelu i czasu sieci |
| `cli/cases.json`, `expected/migration.json` | Macierz argumentów poniżej; oczekiwane liczniki efektów, aliasy i zachowane SHA | T0 może sprawdzić spójność danych przed implementacją rdzenia |

Minimalny pierwszy blok `SYNTHETIC01.md` ma postać:

```markdown
# Fixture A — ekran

Fixture Channel · 0:16 · https://youtu.be/SYNTHETIC01

---

# 📋 Full summary of the video

_2026-01-01 12:00_

## In short
Synthetic result: the screen shows 7.
```

Dopisać dwa własne bloki z separatorami `---`, pytaniem `# ❓ Co pokazuje ekran?`
i `# 🔧 Fixture teardown — mój temat`, odpowiedzią `[0:03] Syntetyczny ekran: 7.`
oraz datami `12:01`, `12:02`. To dane testowe, nie historyczna odpowiedź modelu.
Wariant `expired-local-cache` ustawia mtime `info.json` na `nowSeconds-172801`;
sama migracja/odczyt nie może przez to uruchomić cleanup ani usunąć analizy.

## Zamrożony kontrakt HTTP i SSE

Obserwowane wejścia w `app.py`: `GET /`, `GET /i18n.json`,
`GET /api/watch?url=...&q=...&lang=...&mode=...`, `GET /video/{vid}.mp4`,
`GET /frame/{vid}/{sec}.jpg` (`sec` jest liczbą całkowitą). `url` jest wymagane;
`q=""`, `lang=OMNI_LANG` (domyślnie `en`), `mode="ask"`. Obecnie nieznany język
wraca do `OMNI_LANG`, a tryb inny niż `teardown` do `ask`. Brak `url` w FastAPI
daje 422; test zgodności zachowuje status, nie frameworkowy tekst błędu.

SSE: `Content-Type: text/event-stream` (dopuszczalne `charset`),
`Cache-Control: no-cache`, `X-Accel-Buffering: no`. Każda ramka:
`event: <name>\ndata: <JSON>\n\n`; porównywać JSON strukturalnie, nie odstępy/ascii escaping.
Minimalny sukces dla fixture A i stuba `(in=1000,out=200,parts=1,reused=true)`:

| Kolejność | `event` | `data` |
|---|---|---|
| 1 | `stage` | `{"step":"download"}` |
| 2 | `meta` | `{"id":"SYNTHETIC01","title":"Fixture A — ekran","channel":"Fixture Channel","duration":"0:16","seconds":16,"strip":[0,2,2,4,4,6,6,8,8,10,10,12,12,14,14,16]}` |
| 3 | `stage` | `{"step":"upload"}` |
| 4 | `parts` | `{"n":1,"starts":[0]}` |
| 5 | `uploaded` | `{"reused":true}` |
| 6 | `stage` | `{"step":"watch","parts":1,"fps":10}` |
| 7 | `stage` | `{"step":"answer"}` (jeżeli stub emituje tokeny) |
| 8+ | `answer` | `{"text":"## Answer\n"}`, potem `{"text":"## Answer\n[0:03] Syntetyczny ekran: 7."}` |
| koniec | `done` | `{"seconds":2,"tokens":1200,"parts":1,"reused":true,"cost":0.0002}` przy czasie pracy stuba 2 s |

Każde `answer.text` jest pełnym dotychczasowym tekstem, nie deltą. Ostatnia odpowiedź
może powtórzyć ostatni chunk; test nie wymaga konkretnej liczby chunków ani throttlingu
0,1 s. Finalne `answer` poprzedza `done`. `seconds` w `meta` to długość filmu,
w `done` to czas pracy. Powyższy koszt jest bieżącym wzorcem kompatybilności przy
znanym użyciu, nie cennikiem przyszłego wydania.

`multipart` używa osobnego info ze `duration=2402`: przy 2 fps i limicie 2400 powstają
3 części, starty `0`, `2402/3`, `4804/3`. `parts.n=3`, `stage.watch.parts=3`,
`fps=2`, trzy `part_done:{"i":0|1|2}` w dowolnej kolejności, następnie `merge:{}`,
pełne `answer`, `done.parts=3`. Starty liczbowe porównywać z tolerancją, nie snapshotem
zapisu zmiennoprzecinkowego. Przy `duration=1200` jest jedna część, przy `1201` dwie.

`error` po kontrolowanym błędzie ma `{"message":"fixture failure"}`; stream kończy
się bez `done`. W przypadku błędu zapisu po odpowiedzi tekst może już być wysłany,
ale sukces nie jest deklarowany. Nie utrwalać jako wymogu limitu ostatnich 600 znaków
ani ujawniania surowych błędów; test wymaga czytelnego komunikatu bez sekretów.

HTTP mediów: istniejące ID → dokładne bajty i `video/mp4`; Range `bytes=0-15` → 206,
16 bajtów i poprawne `Content-Range`; brak/nieprawidłowe ID → 404. Istniejąca klatka
→ bajty JPEG, brak wywołania ffmpeg. Świeżą klatkę sprawdza osobny jawny test narzędzia
na syntetycznym filmie. Walidacja traversal/symlinków i ujemnego czasu nie ma utrwalać
luk starej implementacji. `/i18n.json` zachowuje języki `en/pl/de/es/fr` oraz używane
przez HTML obiekty `name`, `ui`, `sections`.

## Macierz testów do przygotowania teraz

| Nazwa podtestu | Wejście i asercja | Etap zaliczenia |
|---|---|---|
| `fixture-integrity` | Każdy wpis manifestu istnieje i ma zapisany SHA; JSON parsowalny poza nazwanymi malformed; tylko syntetyczne źródła | T0, niezależnie od biblioteki |
| `legacy-identities` | Wszystkie aliasy z `ids.json`; stabilne mapowanie po dwóch importach; żadnej zmiany nazw plików | Dane T0, adapter T7 |
| `configuration-precedence` | Plik vs env, inne CWD, brak klucza, nieobsługiwane minutes | T7; brak klucza nie blokuje migracji |
| `cli-argv` | `URL`; `URL -q 'koszt AI — mój temat' --lang pl`; długi `--question`; `URL --teardown -q 'mój temat'`; `--help` | Zachowane argumenty jako lista, bez shell/string join; help bez modelu |
| `cli-process` | Stub dziecka kończy się 0 i 23; przerwanie podczas pracy; ścieżka instalacji ze spacjami | Właściwy exit code, przekazane przerwanie, brak osieroconego procesu; osobno macOS/Windows |
| `launcher-preflight` | Brak Node, brak pliku entrypointu, nieobsługiwana wersja | Niezerowy exit i konkretna instrukcja; brak fallbacku do analizy Python, brak zmian danych |
| `sse-success-and-failure` | Trzy sekwencje powyżej odtwarzane przez nowy HTTP; stary HTML jako konsument | Postęp, pełne odpowiedzi, końcowe done/error; transport nie uruchamia automatycznej ponownej pracy |
| `summary-focus-teardown-followup` | Puste `q`, temat PL, teardown z tematem, „Rozwiń punkt 2” | Puste legacy ask → summary; pierwsze ask.q → focus; teardown.q → question; follow-up.q → question + właściwy parentTurnId; sprawdzić payload stuba, nie tylko UI |
| `conversation-isolation` | Po A wybrać B, odpowiedź/klatka/seek karty A | Zachowany film A; brak historii A w nowej rozmowie B; identyczny URL nie jest sam w sobie identyfikatorem rozmowy |
| `media-compatibility` | MP4 Range, zapisany JPEG, brak cache, zły ID | Statusy i bajty powyżej, czytelna stara analiza mimo braku mediów |
| `legacy-oss-units` | fresh/expired/invalid/malformed/future | Sekundy konwertowane wyłącznie w adapterze, brak modyfikacji oryginalnego `oss.json`; nieważne wpisy nie są reusable |
| `migration-offline-idempotent` | Instalacja synthetic → migracja → odczyt → migracja ponownie → odczyt | Wszystkie liczniki downloader/upload/provider = 0; identyczne stare SHA; stałe aliasy i liczba zaimportowanych zapisów |
| `migration-damaged-cache` | Każdy wariant z `variants.json` oddzielnie | Analizy nadal dostępne; diagnostyka; brak pobrania „naprawczego” bez zlecenia analizy |
| `rollback-with-new-result` | Po migracji zapisać nową analizę przez stub, potem rollback paczki | Stara beta odzyskuje oryginalne dane/konfigurację; nowy wynik pozostaje dostępny w udokumentowanej lokalizacji, nic go nie kasuje |
| `release-preflight-and-identity` | Wadliwy checksum, niepełne wydanie, zmieniony plik hosta; poprawny tarball dla obu powłok | Preflight bez częściowej instalacji; kopia i konflikt; ten sam hash rdzenia; brak prywatnych plików/sekretów w paczce |

Testy migracji nie wymagają identycznego wygenerowanego tekstu nowej analizy; wymagają
identycznych bajtów zachowanych starych analiz. Liczniki wywołań są mierzone, a nie
wnioskowane z braku klucza. Test pierwszej nowej analizy jest oddzielny i zezwala tylko
na jawny stub; nie można jego wywołań wliczać do migracji ani nimi maskować pobrań.

## Zweryfikowane rozbieżności i bramki integratora

1. README i `.env.example` opisują `OMNI_PART_MINUTES=40`, kod używa
   `OMNI_MAX_FRAMES=2400` z minimum 300. Dla długiego materiału przy 2 fps dzielenie
   zaczyna się powyżej 1200 s (20 min), nie dopiero po 40 min. Test zamraża zachowanie
   kodu, instrukcja migracji opisuje rozbieżność.
2. Python używa `round()` z zaokrągleniem połówek do parzystej liczby. Dlatego strip
   16 s ma duplikaty i kończy się na 16; JavaScript `Math.round` da inny wynik. T0
   musi jawnie zamrozić zgodność lub przyjąć udokumentowaną poprawkę; powyższy golden
   zapisuje stan bety, nie sugeruje dobrego doboru klatek na końcu filmu.
3. Obecny frontend po teardownie wymusza dla dalszego pytania `ask`, ale nie wysyła
   parent/conversation ID. `stream()` wysyła wyłącznie jedną wiadomość użytkownika;
   historyczny Markdown nie jest kontekstem rozmowy. T0/T7 muszą ustalić rozszerzenie
   transportu o tożsamość rozmowy/rodzica bez usuwania starych parametrów. Nie wiązać
   parenta globalnie po samym URL i nie deklarować A14 jako już działającego.
4. `client()` przy braku klucza robi `sys.exit`; worker SSE łapie tylko `Exception`.
   To może zakończyć stream bez zdarzenia `error`. Nowy adapter ma spełnić czytelny
   błąd przed pracą, a nie zachować ten brak komunikatu.
5. Beta przy braku usage liczy zero tokenów/kosztu, a `oss.json` nie waliduje czasu
   z przyszłości. Plan wymaga kosztu nieznanego przy braku metryki i nieważnych uploadów
   odrzuconych. Stary HTML wywołuje `d.cost.toFixed(3)`: T0/T7 muszą zamrozić sposób
   przedstawienia nieznanego kosztu oraz dostosować konsumenta bez przedstawiania zera
   jako prawdziwej ceny. Golden sukcesu dotyczy tylko znanych metryk.
6. Istniejący `agent-os-module/test/card-source.test.mjs` dotyczy karty Agent OS,
   nie Python/SSE/migracji. Korzysta z TypeScript/React w `AGENT_OS_SOURCE` (domyślnie
   prywatna instalacja); odczytane `node.test.mjs` i `transcript.test.mjs` mają podobny
   mechanizm zależności. Nie stanowią dowodu niezależnego harnessu T0. Nie znaleziono
   testów Python ani root/module `package.json` w przeglądzie; nowe skrypty z TEST-PLAN
   są planem, nie komendami już potwierdzonymi. Żaden istniejący test nie był uruchamiany.

Dowód odbioru T7/T8 powinien zawierać: wersje środowiska i artefaktu, SHA manifestu,
liczby wywołań, porównanie SHA przed/po, wynik drugiej migracji i rollbacku oraz raport
macOS/Windows (Linux dodatkowo dla hosta). Przygotowanie tego inwentarza nie zalicza T17.

## Rozstrzygnięcie koordynatora po audycie

Zamrażamy legacy strip w adapterze bety; E dodaje identyfikatory konwersacji do
transportu, formatter kosztu nieznanego i jawny błąd brakującego klucza. Nie zmieniamy
układu UI. Zestaw goldenów pozostaje danymi T0, a poprawna obsługa nowych stanów ma
osobne testy T7; [przydział i zasady](README.md#rozstrzygnięcia-audytów-do-przekazania).
