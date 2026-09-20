# Plan równoległej pracy agentów

Stan na 2026-09-20, po sesji, w której powstał skan kanału. Ten dokument istnieje po to,
żeby po kompakcie sesji dało się rozdać zadania agentom bez czytania całej historii.

---

## Zasada, na której to stoi: jeden plik ma jednego właściciela

To jest jedyna rzecz, która decyduje o tym, czy równoległa praca się uda, czy skończy
się ręcznym scalaniem. Agenci nie widzą swoich zmian nawzajem. Dwóch agentów
edytujących ten sam plik to gwarantowany konflikt, a przy plikach po 600 linii
z gęstymi komentarzami scalanie kosztuje więcej niż napisanie od nowa.

Dlatego każdy strumień poniżej **dostaje na własność konkretne pliki** i ma zakaz
dotykania pozostałych. Tam, gdzie potrzebne jest wpięcie w istniejący kod, agent
zostawia to mnie — integracja jest krokiem szeregowym, nie równoległym.

**Pliki, których w fazie równoległej nie rusza NIKT** (wpinam je sam na końcu):

- `src/app/api/omniwatch/channel/route.ts`
- `src/components/ChannelScan.tsx`
- `src/lib/omniwatch.ts`
- `src/lib/omniwatchChannel.ts`

Uwaga o skali, bo lepiej ją powiedzieć teraz niż odkryć w konfliktach: **realna
szerokość to około siedmiu agentów naraz, nie sto.** Moduł ma ~3000 linii w kilkunastu
plikach. Stu agentów nie miałoby czego robić bez wchodzenia sobie w drogę — wąskim
gardłem nie jest liczba agentów, tylko liczba rozłącznych kawałków.

---

## Faza 0 — jeden agent, musi skończyć przed S2 i S3

### S0. Bezpośredni klient Apify

**Dlaczego pierwszy:** dziś jedyna droga do Apify prowadzi przez `hermes -t apify`
(`omniwatchScout.ts`). To wiąże moduł z Hermesem, a moduł ma być samodzielny. S2 i S3
oba tego potrzebują, więc musi powstać zanim ruszą.

**Na własność:** `src/lib/apify.ts` (nowy).

**Zakres:** `runActor(actorId, input, opts)` → pozycje z datasetu. Token z
`APIFY_TOKEN` w środowisku, potem `~/.hermes/.env`, potem `~/.agentic-os/config.json` —
tą samą kolejnością co `apiKey()` w silniku. Odpytywanie o stan runu z rozsądnym
odstępem i limitem czasu. Błąd bez tokenu ma mówić **co zrobić**, nie co się stało
wewnątrz.

**Test odbioru:** bez tokenu — czytelny komunikat, zero wyjątków. Z tokenem — aktor
`apidojo~tweet-scraper` zwraca niepustą listę dla znanego konta.

---

## Faza 1 — równolegle, siedem strumieni

### S1. Prawdziwe wykrywanie ujęć (ffmpeg) + długość z ffprobe

**Dlaczego:** dzisiejszy szkielet czyta listę scen z prozy, a prompt ogranicza ją do
dwunastu pozycji. Zmierzone na prawdziwym wyniku: karta mówi **12 cięć na 10 s**, lista
scen implikuje **2,1**. Sześciokrotny błąd — ta lista jest streszczeniem, nie zapisem
montażu. ffmpeg na tym samym pliku wykrył **40 cięć**, ujęcia 0,97–3,4 s.

**Na własność:** `src/lib/omniwatchCuts.ts` (nowy), `src/lib/omniwatchSkeleton.ts`
(przepisanie).

**Uwaga o kolejności:** jeśli rozpoznanie S7 (JSON zamiast prozy) wypadnie dobrze,
nakładanie tekstu na cięcia robi się trywialne, bo sceny przychodzą już jako struktura.
Warto zerknąć na wynik S7 przed pisaniem tej części.

**Zakres:**
- `detectCuts(file)` → `{ at, dur }[]` przez `select='gt(scene,T)',showinfo`. Próg `T`
  dobrać pomiarem na plikach w `~/.agentic-os/omniwatch/cache/`, nie zgadywać.
- `probeDuration(file)` przez ffprobe. **To nie jest kosmetyka:** przy bezpośrednim MP4
  (reklamy Meta) yt-dlp nie podaje długości, a bez niej wycena pokazuje $0 — czyli łamie
  jedyną obietnicę, na której stoi ta funkcja.
- Szkielet budowany z prawdziwych granic, a tekst z listy scen **nakładany** na nie po
  czasie. Semantyka z modelu, rytm z ffmpega.

**Test odbioru:** na każdym pliku w cache liczba cięć mieści się w granicach dwukrotności
tempa podanego na karcie; żadne ujęcie nie trwa 0,1 s; film bez cięć (gadająca głowa)
zwraca jedno ujęcie, a nie błąd.

---

### S2. X (Twitter) jako źródło

**Na własność:** `src/lib/omniwatchX.ts` (nowy). **Zależy od S0.**

**Zakres:** handle → `ChannelVideo[]` w kształcie identycznym z tym, co zwraca
`listChannel` (`url, title, views, duration?, postedAt?`). Przez `apidojo~tweet-scraper`,
tylko wpisy z wideo. Adresy wideo z X-a yt-dlp obsługuje — to jest sprawdzone, bo
z takiego linku zrobiliśmy wcześniej demo z Qwenem.

**Test odbioru:** znane konto zwraca same wpisy z wideo, z poprawnymi liczbami; konto
bez wideo zwraca pustą listę, nie wyjątek.

---

### S3. Reklamy Meta jako źródło

**Na własność:** `src/lib/omniwatchAds.ts` (nowy). **Zależy od S0.**

**Zakres:** zapytanie lub `pageId` → `ChannelVideo[]`. Aktor
`igolaizola/facebook-ad-library-scraper`, **$0,30 za 1000 wyników, bez logowania**,
filtr `mediaType: Videos`. Zwraca bezpośrednie adresy mediów, a te przechodzą przez nasz
silnik — **sprawdzone dzisiaj na żywo**: reklama odzieżowa, preset „ubrania i kolory",
$0,0103, pełna odpowiedź ze znacznikami czasu.

**Zakres obejmuje też uczciwość ekranu:** to jedyne źródło, w którym samo *listowanie*
kosztuje. Obietnica „listowanie jest darmowe" tu nie obowiązuje i interfejs musi to
mówić, tak jak już mówi przy Instagramie.

**Test odbioru:** zwrócone pozycje mają pobieralne adresy wideo (HTTP 200,
`content-type: video/*`).

---

### S4. Rytm w budowaniu wideo — opcjonalne długości scen

**Na własność:** `src/app/api/video/auto/assemble/route.ts` **w instalacji Agent OS**
oraz nowa idempotentna funkcja w `agent-os-module/register-nav.py`.

**Dlaczego przez `register-nav.py`:** to nie jest nasz plik. Moduł musi go łatać tak,
jak łata Astrosa — z wartownikiem, który nie pozwala nałożyć zmiany dwa razy.

**Zakres:** każda scena może nieść opcjonalne `seconds`. Gdy są obecne, **zastępują wagi
liczone z liczby słów** (linie 218–226) — nadal normalizowane do długości narracji, żeby
obraz nie rozjechał się z dźwiękiem. Gdy ich nie ma, zachowanie bez zmian, co do bajtu.
Podnieść limit `slice(0, 12)` na ~60, bo krótki film z dwunastoma cięciami na dziesięć
sekund ma ich pięćdziesiąt kilka.

**Test odbioru:** to samo żądanie bez `seconds` generuje identyczny `index.html` jak
przed zmianą; z `seconds` — `data-duration` odpowiadają proporcjom, a suma zgadza się
z długością narracji.

---

### S5. DESIGN.md — poprawki i uzupełnienia

**Na własność:** `DESIGN.md`. Nikt inny go nie dotyka.

**Zakres — §6 zawiera nieprawdę i to jest najpilniejsze:** dokument twierdzi, że
przewagą jest samo oglądanie obrazu. **HypeKit też ogląda** — ich dokumentacja każe
agentowi wyciągać klatki (`media frames`), składać je w siatki z transkryptem
(`media tile`) i wykrywać granice ujęć (`media boundaries`), a potem czytać to modelem
multimodalnym. Różnica jest realna, ale węższa: oni tną na klatki dla agenta kodującego,
my wysyłamy cały film z dźwiękiem w jednym zapytaniu do modelu natywnie omni. Taniej
i prościej u nas, sterowalniej u nich.

Dopisać też: presety, ALL bez sufitu, historię skanów, tabelę progów wejścia dla źródeł
(tylko YouTube i TikTok są zero-setup) i wniosek, że **reklamy Meta nie są funkcją dla
społeczności Juliana**, tylko dla części e-commerce.

**Licencja HypeKit, do zanotowania:** zmodyfikowany Apache 2.0. Zabrania multi-tenant
SaaS i sprzedaży pochodnych. Użycie komercyjne u siebie i dla klientów — dozwolone.
Niezależna implementacja podobnej architektury jest poza zasięgiem licencji na kod.
Czyli: ich kodu nie bierzemy, struktura jest wolna.

---

### S6. Dokończenie tłumaczeń

**Na własność:** `src/lib/omniwatchI18n.ts`.

**Zakres:** etykiety presetów w pięciu językach; usunięcie martwych kluczy `adapt`
(zostały po skasowanej sekcji „Your version"); sprawdzenie, że każda lokalizacja ma
komplet kluczy — brakujący klucz cicho degraduje się do angielskiego i nikt tego nie
zauważy.

---

### S7. Rozpoznanie: czy model może odpowiadać JSON-em zamiast prozą

**To jest rozpoznanie, nie wdrożenie.** Kończy się odpowiedzią i pomiarem, nie
przepisaniem silnika. Uruchomić wcześnie, bo wynik może mocno uprościć S1.

**Na własność:** `agent-os-module/spike/json-output.ts` (nowy katalog, poza `src/`).
Nie dotyka niczego produkcyjnego.

**Skąd pomysł:** karta z zamkniętymi wartościami już *udaje* tabelę, a szkielet
wyciągamy parsowaniem markdownu. Jeśli model potrafi zwrócić od razu strukturę, cały
krok parsowania znika — a z nim klasa błędów, którą dziś łapiemy ręcznie (parser czytał
dwie listy naraz i sklejał je; próg 120 słów na rozpad prozy; zgadywanie, która sekcja
jest listą scen).

**Do sprawdzenia, po kolei:**

1. Czy `dashscope-intl` w trybie zgodności przyjmuje `response_format: {"type":
   "json_object"}` razem z `stream: true`, `modalities:["text"]` i wejściem wideo.
   To trzy warunki naraz i żaden nie jest oczywisty — strumieniowanie jest u nas
   obowiązkowe, a wymuszony JSON bywa wyłączany właśnie przy multimodalnym wejściu.
2. Czy bez `response_format`, samym promptem, model trzyma poprawny JSON przez całą
   odpowiedź. Zmierzyć na tych samych plikach z cache: ile odpowiedzi parsuje się za
   pierwszym razem, na dziesięć prób.
3. Czy jakość **treści** nie spada. To jest realne ryzyko, nie formalność: wymuszona
   struktura potrafi zubożyć obserwacje. Porównać tę samą kartę prozą i JSON-em na tym
   samym filmie — czy JSON nadal zauważa kieszenie w [0:13] i paletę pomieszczenia.
4. Czy JSON zmniejsza, czy zwiększa rozpad. Może pomóc, bo struktura ogranicza; może
   zaszkodzić, bo model dopycha pola, żeby wyglądały na wypełnione.

**Haczyk, który przesądza o decyzji — proza psuje się łagodnie, JSON całkowicie.**
Urwany teardown wciąż daje się czytać do miejsca urwania; urwany JSON to zero. A my
mamy realne ryzyko urwania: limit wyjścia to 4000 tokenów, a tryb „jedno i drugie"
generuje dwa dokumenty naraz i na długim filmie może się nie zmieścić. Więc jeśli JSON
wchodzi, to razem z naprawą niedomkniętego JSON-a albo z zapasowym przebiegiem, a nie
zamiast nich.

**Rekomendacja na wypadek, gdyby punkty 1–3 wyszły dobrze:** JSON jako *jedyne* źródło
prawdy, a markdown generowany z niego po stronie przeglądarki. Jedna struktura, wiele
widoków — i wtedy szkielet, tabela porównawcza trzydziestu filmów oraz plan scen dla
`auto/assemble` wypadają z tej samej rzeczy za darmo. Dziś każdy z nich wyciągamy
osobno z tekstu.

**Test odbioru:** raport z liczbami — ile z dziesięciu odpowiedzi było poprawnym
JSON-em w każdym wariancie, oraz zestawienie obok siebie tej samej karty prozą i
JSON-em. Rekomendacja „wchodzimy / nie wchodzimy" z uzasadnieniem opartym na tych
liczbach, nie na przeczuciu.

---

## Faza 2 — szeregowo, po fazie 1

### I1. Integracja (robię sam)

Wpięcie S1–S3 w `channel/route.ts` i `ChannelScan.tsx`: X i reklamy jako kolejne
platformy, szkielet z prawdziwych cięć zapisywany przy skanie.

### I2. Most do odtwarzania filmu

Dopiero gdy S1 i S4 są gotowe, bo bez prawdziwych cięć i bez przyjmowania długości nie
ma czego przenosić.

Kształt: obejrzany film → szkielet (rytm z ffmpega, sens z Omni) → Twój temat i kąt →
narracja → `POST /api/video/auto/assemble` z jawnymi `seconds` → HyperFrames.

**Granica, której nie przekraczamy i którą trzeba pilnować:** przenosimy **rytm**, nie
treść. Napisy w planie scen zostają puste celowo. Sekcja „Your version" została
skasowana właśnie dlatego, że czytała się jak „ukradnij ten film", i wracanie do tego
tylnymi drzwiami przez gotowy plan montażu byłoby tą samą rzeczą pod inną nazwą.

---

## Do zrobienia niezależnie, kiedykolwiek

- **Ponawianie nigdy nie zostało wywołane.** Napisane rano, przeszło typecheck, ale
  każdy przebieg udawał się za pierwszym razem. Wycelować w martwy port i sprawdzić trzy
  próby z narastającym odstępem, a potem „gave up after 4 attempts".
- **Tryb „jedno i drugie" na długim filmie.** Dwa dokumenty w jednej odpowiedzi przy
  limicie 4000 tokenów wyjścia. Na shorcie zmieściło się z zapasem; przy godzinnym
  kursie może się urwać w połowie. Sprawdzić i w razie czego podnieść limit dla tego
  jednego trybu.
- **Push do `agent-os-local`.** Commity są lokalnie, repo potwierdzone jako prywatne.

---

## Co każdy agent musi dostać w zleceniu

1. **Styl komentarzy.** Ten moduł tłumaczy *dlaczego*, nie *co*, i zapisuje przy okazji,
   co zostało zmierzone i co się nie udało. To jest celowe. Agent, który napisze
   `// pobierz plik`, rozjedzie się z resztą pliku.
2. **Zakaz dotykania cudzych plików**, wypisany z nazwy.
3. **Test odbioru jako polecenie do uruchomienia**, nie jako opis.
4. **Zakaz zmyślania liczb.** Wszystkie koszty i progi w tym module są mierzone. Jeśli
   agent czegoś nie zmierzył, ma napisać, że nie wie.

---

## Stan wykonania po sesji 2026-09-20 (wieczór UTC)

**Cel bez zmian** — ten sam, który prowadził Claude: Astros → OmniWatch (rozbiórka) →
Twój temat → brief → gotowy film (głos, b-roll, grafiki, montaż). To **nie** jest
deklaracja ukończenia celu: integracja finalna i most do montażu są otwarte.

Potwierdzone uruchomieniem (szczegóły i komendy w `STATUS.md`):

- grafiki: walidacja wejść + `bytes=-N` naprawione; **72/72** testów
  (`agent-os-module/test/graphics/graphics.test.mjs`), live POST 3/3 → 400, `tsc` 0 błędów;
- karta A→B (`card-source`): 10/10 testów — raport agenta `fix_card_source`;
- assembler: 21 testów + parity świeżego instalatora — raport agenta montażu;
- recreate (sync): 18 testów — raport agenta recreate;
- głos lokalny (`say` + ffmpeg): `available: true`, MP3, 4 live checks — raport agenta głosu;
- HyperFrames zainstalowane; finalny MP4 **47,13 s** (`smoke-e2e/final-smoke.mp4`,
  `ffprobe` → 47.133333 s, zmierzone przeze mnie); UI wpięte, `tsc` czysty.

**CRITICAL OPEN:** autor skryptu (`auto/script`, angle/hints → Grok/Claude) **odrzucony
przez approval** (wymaga jawnej zgody użytkownika na payload/destination) — to samo dla
runtime Flasha; providerzy niedostępni (limit Claude, CLI Grok, Ollama), więc skrypt
próbki napisał ręcznie agent Flash, nie runtime. `review_bridge` to proponowany patch w
workspace, czeka na zatwierdzenie. Dlatego cel **nie** jest domknięty i nic nie idzie
publicznie; bez commit/push.

Otwarte / pending do potwierdzenia przez agentów: most do montażu w UI, instalator po
zmianach, pozostałe bridge'y. Nic nie jest commitowane ani pushowane.

Znane ograniczenie tej maszyny: ffmpeg bez `drawtext` (brak `ffmpeg-full`), więc
ffmpegowa ścieżka grafik nie ma dowodu end-to-end; produkcyjnie karty renderuje HTML w
kompozycji montażu.
