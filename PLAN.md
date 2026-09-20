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
szerokość to około sześciu agentów naraz, nie sto.** Moduł ma ~3000 linii w kilkunastu
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

## Faza 1 — równolegle, sześć strumieni

### S1. Prawdziwe wykrywanie ujęć (ffmpeg) + długość z ffprobe

**Dlaczego:** dzisiejszy szkielet czyta listę scen z prozy, a prompt ogranicza ją do
dwunastu pozycji. Zmierzone na prawdziwym wyniku: karta mówi **12 cięć na 10 s**, lista
scen implikuje **2,1**. Sześciokrotny błąd — ta lista jest streszczeniem, nie zapisem
montażu. ffmpeg na tym samym pliku wykrył **40 cięć**, ujęcia 0,97–3,4 s.

**Na własność:** `src/lib/omniwatchCuts.ts` (nowy), `src/lib/omniwatchSkeleton.ts`
(przepisanie).

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
