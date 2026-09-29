# Plan v2 — klon formatu, rozdzielony na równoległe pakiety

> **Dokument historyczny — oznaczono 2026-09-22.** Aktualny stan: [STAN.md](agent-os-module/docs/STAN.md).
> Odłożony szkic techniczny (priorytety nieuzgodnione): [ZADANIA.md](agent-os-module/docs/ZADANIA.md).
> Poniższe otwarte zadania i wyniki opisują moment powstania dokumentu.

**Data:** 2026-09-21
**Podstawa:** `RESEARCH-CLONE-ARCHITECTURES.md` (Hypit / OpenShorts / video-use, czytane z repo)
oraz `HANDOFF-CLONE-PIPELINE.md` (stan pipeline'u).

---

## 0. Zasady, które obowiązują wszystkie pakiety

**Podział instrumentów** — wynik researchu, nie preferencja:

| instrument | odpowiada na | nigdy nie odpowiada na |
|---|---|---|
| **Omni** | znaczenie i struktura; kategorie i listy decyzji z zamkniętych zbiorów | wielkości ciągłe (rozmiary, procenty, sekundy) |
| **Piksele** | wszystkie liczby geometryczne | co to jest i po co |
| **Aligner** (Scribe, mamy) | czas słów | cokolwiek wizualnego |

**Prawo.** Struktura montażu jest wspólnym dobrem branży; chroniony jest kod i teksty promptów.
Dlatego: własne nazwy pól, własne prompty pisane od zera, zero przeklejonego kodu, zero
przeklejonych stringów. Z OpenShorts i video-use (MIT) wolno brać kod — i tak piszemy swoje.

**Reguła dla każdego pakietu.** Jeśli coś nie da się wyrazić w IR, **nie wolno napisać reguły,
która to kasuje**. Trzeba dodać pole albo zgłosić to jako brak. Pięć awarii z 21.09 miało
dokładnie ten kształt.

---

## 1. Protokół dla subagentów (ważne — poprzednia próba padła)

Pięć subagentów na pięć wykonało pracę i wróciło z pustą ostatnią wiadomością. Kanał zwrotny
jest zawodny, więc go omijamy:

1. Każdy agent **zapisuje deliverable do pliku** pod ścieżką podaną w zleceniu.
2. W odpowiedzi podaje **tylko ścieżkę i jedno zdanie statusu**.
3. Orkiestrator czyta plik i to on jest źródłem prawdy.
4. Każdy pakiet ma **rozłączny zbiór plików do edycji** — dwóch agentów nigdy nie dotyka tego
   samego pliku (to drugi klasyczny powód, dla którego równoległość się sypie).
5. Zlecenie zawiera: cel jednym zdaniem, listę plików **do edycji**, listę plików **tylko do
   odczytu**, definicję ukończenia, komendę testu i zakaz wychodzenia poza swoje pliki.

---

## 2. Fala A — trzy pakiety, zero zależności, w pełni równolegle

### A1. Kontrakt renderera ✅ ZROBIONE (21.09, po kompakcie)
**Zmierzone:** setup 46,6 s → **1,8 s**, cały render 1 min 47 s → **14,7 s**, te same piksele.
**Uwaga z logu, której plan nie przewidywał:** `static-frame dedup: disabled (no GSAP tweens)`
— rejestracja timeline'u odkupuje **setup**, a nie dedup. Dedup potrzebuje prawdziwych tweenów
i włączy się dopiero z warstwą ruchu (B1/C1). Komentarz w kodzie mówi to wprost.
**Jak:** jedna stała `COMPOSITION_ID` obsługuje oba miejsca (wrapper i klucz w `__timelines`),
bo rozjazd między nimi jest niewidoczny — wygląda dokładnie jak brak timeline'u.
**Test:** `style.test.mjs` — „the composition registers a paused timeline under its own id".

### A1 (oryginalne zlecenie)
**Edytuje:** `src/lib/omniwatchCompose.ts` (tylko emisja `<style>` / `#stage` / skrypt).
**Czyta:** `hyperframes docs gsap`, `hyperframes docs data-attributes`.
**Robi:** kompozycja rejestruje `window.__timelines[<id kompozycji>]` jako spauzowaną timeline'ę
GSAP i używa id wymaganego przez dokumentację. Nic poza tym.
**Dowód ukończenia:** ten sam projekt renderuje się mierzalnie szybciej; w logu znika
`[StaticGuard] Invalid HyperFrame contract` i `sub_timeline_readiness_timeout`.
Zmierzone na kopii: **1 min 47 s → 21,6 s**.
**Test:** `node --test agent-os-module/test/style.test.mjs agent-os-module/test/recipe.test.mjs`
plus jeden render.

### A2. Aligner w ścieżce klonowania ✅ ZROBIONE (21.09, po kompakcie)
**Jest:** `src/lib/omniwatchCues.ts` (+ wywołanie w `omniwatchMeasure.ts`, + `test/cues.test.mjs`).
**Zmierzone na filmie referencyjnym:** 68 czasów słów, **19/19 porcji captiona** przesuniętych na
granice słów (19 usłyszanych, 0 zgadywanych), **12 zakresów insertów** przyciągniętych z zapasem
60 ms. Drugi przebieg: „word times **from cache**" — aligner płacony raz na źródło.
**Efekt widoczny w czasach:** „Built like a" miało 4,00–5,10 z podziału proporcjonalnego,
ma 4,04–5,28 z nagrania; cięcie wypada na początku słowa „plays".
**Czego NIE zmienia:** tekstu ani zaznaczenia — to zostało odczytane z ekranu. Zdanie, którego
nikt nie wypowiada (tytuł), zachowuje czas, z jakim je zobaczono.
**Degradacja:** brak klucza / brak dźwięku / brak dopasowania → dzisiejsze czasy i notatka
z powodem. Klon bez alignera ma być lekko rozjechany, nie zepsuty.

### A2 (oryginalne zlecenie)
**Edytuje:** nowy `src/lib/omniwatchCues.ts` + miejsce wywołania w `src/lib/omniwatchMeasure.ts`.
**Czyta:** `src/lib/omniwatchTranscript.ts` (jest gotowe: `wordsOf`, `cuesFromWords`, `alignCues`).
**Robi:** czasy słów pobierane raz na źródło i cache'owane; porcje captiona cięte **na granicach
słów**, nie po liczbie znaków; zakresy insertów przyciągane do granic słów z zapasem 30–200 ms.
**Dowód:** w logu measure znika „cut into chunks of ~N characters", pojawiają się granice słów;
caption w renderze zmienia się na słowach, nie w połowie wyrazu.
**Uwaga:** `omniwatchTranscript.ts` jest **tylko do odczytu** — działa, nie ruszać.

### A3. Kontrakt v2 — dokument, nie kod ✅ ZROBIONE (21.09, przed kompaktem)
**Jest:** `agent-os-module/docs/IR-CONTRACT-V2.md`.
**Czyta:** `RESEARCH-CLONE-ARCHITECTURES.md`, nasz `omniwatchRecipe.ts`, `omniwatchBlueprint.ts`.
**Robi:** spisuje **nasz** kontrakt — własne nazwy pól — na cztery brakujące obszary: ruch,
komponent ze stanem, kotwice słowne, jawna kolejność warstw. Dla każdego pola: co wyraża, typ,
zakres, kto je wypełnia (Omni / piksele / aligner) i co się dzieje, gdy go brak.
**Dowód:** każdy z pięciu dzisiejszych braków (inserty, porcje captiona, liczba kafelków, ruch,
drop do rzędu) ma w dokumencie pole, które by go wyraziło.

---

## 3. Fala B — po A3, trzy pakiety równolegle

### B1. Słownik ruchu
**Edytuje:** nowy `src/lib/omniwatchMotion.ts` + sekcja `motion` w `src/lib/omniwatchRecipe.ts`.
**Robi:** zamknięty zbiór wejść/wyjść (nasze nazwy), każdy `{start, end, strength}`, plus
**twarde limity w kodzie** wzorem `edit_builder.py`: maksymalna siła, minimalny czas trwania,
maksymalna liczba, brak nakładania. Czysta funkcja: opis ruchu → specyfikacja tweenu GSAP.
Easing nigdy liniowy. Bez dotykania compose.
**Dowód:** testy jednostkowe na dociskanie limitów; funkcja zwraca tween dla każdego wejścia.

### B2. Kafelek ze stanem
**Edytuje:** `src/lib/omniwatchBlueprint.ts` (pola itemu) + nowy `src/lib/omniwatchStage.ts`.
**Robi:** kafelek dostaje stan — leży od początku albo **wchodzi w swoim oknie**; geometria
stage'a (miejsce, gdzie ikona czeka, zanim spadnie) mierzona z pikseli; reguła przejścia
stage → rząd. Bez dotykania compose.
**Dowód:** test na syntetycznej planszy: kafelek z oknem pojawia się na stage'u i ląduje w rzędzie.

### B3. Prompt Omni v2
**Edytuje:** nowy `src/lib/omniwatchCapturePrompt.ts` + test.
**Robi:** **nasz własny** tekst promptu, pisany od zera, pytający wyłącznie o kategorie i listy
decyzji z zamkniętych zbiorów zdefiniowanych w A3. Mocny default („jeśli nie masz pewności,
odpowiedz X"), nazwane dystraktory, zero pytań o wielkości ciągłe, zero pytań o czas słów.
**Dowód:** test sprawdza, że prompt nie zawiera pytania o żaden rozmiar ani sekundę; ręczny
przebieg na naszym filmie referencyjnym.

---

## 4. Fala C — integracja, sekwencyjnie (jeden agent)

### C1. Ruch i drop w compose
Compose zaczyna wywoływać `omniwatchMotion` i `omniwatchStage`. Wymaga A1 (timeline), B1, B2.
**Dowód:** film, na którym karty wjeżdżają, a ikona spada do swojego rzędu — pair + pełny render.

### C2. Hard rules jako testy
**Edytuje:** nowy `test/hard-rules.test.mjs`.
**Robi:** nasze własne reguły poprawności produkcyjnej jako testy, m.in.: napisy rysowane po
nakładkach; żadne cięcie w środku słowa; easing nigdy liniowy; ostatnia klatka trzymana; dwa
niezależne elementy nie odsłaniają się jednocześnie; brak `!important` w wyjściowym HTML.
**Dowód:** testy przechodzą na aktualnym wyjściu albo wskazują konkretne naruszenie.

---

## 4b. Co z tego wyszło (21.09, po kompakcie)

**Fala B — trzy subagenty Sonnet, równolegle, rozłączne pliki.** Protokół z §1 zadziałał:
każdy zapisał raport do pliku i wrócił jedną linijką. Zero pustych odpowiedzi, zero kolizji.

| pakiet | plik | stan |
|---|---|---|
| B1 | `omniwatchMotion.ts` | 24 testy; czysta funkcja `Move` → tween, wszystkie liczby dociskane |
| B2 | `omniwatchStage.ts` + pola `hold`/`waitsAt` | 8 testów; pudełko oczekiwania **mierzone**, nie zakładane |
| B3 | `omniwatchCapturePrompt.ts` | 11 testów; prompt pisany od zera, test zakazanych wzorców broni doktryny |

**Szew, który wyszedł dopiero przy scalaniu** (i który jest argumentem za tym, żeby scalał
orkiestrator, a nie agent): prompt B3 każe Omni odpowiedzieć **gołym stringiem**
(`"arrival": "pop"`), a normalizator B1 przyjmuje wyłącznie **obiekt** i taki string cicho
zamieniał na `cut`. Żaden z nich nie był w błędzie — po prostu nikt nie patrzył na oba naraz.
Adaptacja wylądowała w jednym miejscu: walidator schematu rozszerza gołą nazwę do obiektu,
więc wszystko dalej widzi jeden kształt.

### C1. Ruch i drop w compose ✅ ZROBIONE
Compose wywołuje `omniwatchMotion` i `omniwatchStage`; każdy rysowany element dostał
stabilny identyfikator (40 elementów, 40 unikalnych, zero bez nazwy), a timeline dostaje
gotowe zdania GSAP-a.
**Dowód na renderze filmu referencyjnego:** rząd S pusty o 2,8 i 3,0 s, ikona w locie o 3,2 s,
stoi na miejscu o 3,6 s.
**Skutek uboczny, przewidziany w A1:** `static-frame dedup` **włączył się** — 456/456 klatek
uznanych za powtarzalne i zweryfikowanych, 68–86% realnie użytych ponownie, capture 9,7 → 5,8 s.

### C2. Hard rules jako testy ✅ ZROBIONE
`test/hard-rules.test.mjs`, 12 testów — wszystkie osiem reguł z §6 kontraktu. Każda reguła
napisana dwa razy: film, który jej przestrzega, i film, który ją łamie.
Jedną regułę trzeba było **zawęzić**: napis zmieniający się razem z insertem to nie „dwa
niezależne odsłonięcia", tylko insert ilustrujący zdanie — czyli efekt, po który idziemy.

### Czego nadal nie ma
- **Nic nie wypełnia pól ruchu z Omni.** Prompt B3 istnieje, ale nie jest wpięty w wywołanie
  capture i nikt nie parsuje odpowiedzi. Dowód powyżej powstał z pól wpisanych ręcznie.
  To jest następny pakiet i jest mały: wpiąć prompt, sparsować JSON, zmapować na pola.
- **Oczekiwanie przy głowie** — patrz luka dopisana do §3 kontraktu.
- Dźwięk i generowanie assetów — nadal osobny temat.

## 4c. Drabina evala (21.09)

**Zasada: najtańszy szczebel pierwszy.** Dopiero gdy przechodzi, wchodzimy wyżej. Po każdej
zmianie schodzimy z powrotem na dół.

| szczebel | co sprawdza | koszt | stan |
|---|---|---|---|
| 1. dane ↔ dane | nasza ekstrakcja wobec cudzych **autorskich** danych: słowa, przerwy, obrazy przypięte do mowy | zero — sam tekst | **działa** |
| 2. reguły twarde | 8 reguł produkcyjnych jako testy na wyjściowym dokumencie | zero | **działa** (12 testów) |
| 3. negatywny | film **bez** tabeli nie może wyprodukować rzędów | jeden pomiar | szkielet jest, brak mediów |
| 4. klatka ↔ klatka | nasza klatka obok tej samej sekundy źródła | jeden render klatki | działa ręcznie |
| 5. film ↔ film | poklatkowo, całe 20 s | minuty + kredyty | dopiero gdy 1–4 zielone |

**Ground truth:** 13 przypadków wyciągniętych z cudzych autorskich plików — trzy formaty
(ranking, podcast, street interview) i ich warianty swap. Leżą w `test/eval/ground/`,
**wyłącznie do oceniania**; nic z nich nie trafia do naszego wyjścia.

**Klasyfikacja, która była potrzebna:** wariant `swap-topic` to **inny scenariusz** dla tego
samego filmu. Ocenianie naszej ekstrakcji wobec niego mierzyłoby tylko to, że scenariusze się
różnią. To cel **bramki generowania**, nie odniesienie dla ekstrakcji.

### Wynik na jedynym filmie, którego media mamy

| | my | oni | |
|---|---|---|---|
| słowa scenariusza | **67/67** | 67 | aligner odzyskał wszystko |
| przerwy napisów | **21** | 22 | było 16 przed poprawką |
| obrazy przypięte do mowy | 7 | 8 | jeden mniej |

**Czego brakuje do pełnego zestawu:** mediów do `podcast` i `interview`. Pliki ground truth
już są; potrzebne są ich filmy.

## 4d. Rytm napisów — jak to naprawiliśmy, i czego się przy tym nauczyliśmy

Trzy podejścia, każde obalone pomiarem:

1. **Pakowanie zachłanne** (stan wyjściowy) — wypełnij linijkę do budżetu, zacznij nową.
   Daje cięcia w środku frazy i ogryzek na końcu. 16/22.
2. **Pakowanie równomierne + premia za pauzę** — koszt = kwadrat niewykorzystanego miejsca,
   cięcie w zmierzonej pauzie tańsze. 17/22. Lepiej, ale wciąż za mało cięć.
3. **Cel z filmu** — okazało się, że szerokość pasma **nie jest** ich ograniczeniem: pasmo
   mieści 22 znaki, oni pokazują 14. Szerokość to sufit, nie rytm.

Rytm zmierzyliśmy **z samego filmu**: pasmo napisów wycięte, zmniejszone do paska 96×12,
jedno wywołanie ffmpeg, zliczone zmiany. Pierwsza wersja liczyła 14 (za mało), druga 43 (za
dużo, łapała przeskoki znacznika karaoke). Rozróżnia je nie **wielkość** zmiany, tylko jej
**zasięg**: nowa porcja przerysowuje całą linię, znacznik jej fragment. Po zmianie na zasięg:
**26 zmian wobec 24, które oni napisali.**

Ostatni krok: budżet znaków to sufit, a my mieliśmy cel. Zamiast dobrać współczynnik,
**przeszukujemy sufit** i bierzemy ten, przy którym liczba porcji trafia najbliżej zmierzonej.
Jeden zmierzony cel, zero stałych do strojenia. **21/22.**

**Regresja, którą to wprowadziło i którą naprawiono:** recut gubił znacznik karaoke, bo robił
to stary chunker. Film przez chwilę miał płaskie napisy zamiast podświetlanego słowa.

## 4f. Ile obrazów jest w jednym insercie — 8/8

Bramka mówiła 7 wobec 8. Reguła, która to liczyła, brała **dwie próbki w sztywnych punktach**
(30% i 75% spanu) i porównywała **szerokość** z progiem 1,25. Trzy liczby, wszystkie odczytane
z jednego filmu.

Rozbiło się o ostatni insert referencji, gdzie druga karta wjeżdża **pod** pierwszą: szerokość
rośnie o dziesiątą część (za mało), wysokość prawie dwukrotnie. Para wyszła jako jeden
rozciągnięty obrazek.

**Co zastąpiło regułę:** pipeline **przechodzi span** w ośmiu krokach i sam grupuje to, co
zobaczył. Miarą „czy to wciąż ten sam obraz" jest **część wspólna do sumy pól** — standardowy
sposób pytania, czy dwa prostokąty to ten sam prostokąt. Jedna miara pokrywa oba sposoby, w
jakie referencja zmienia inserty: kartę **dochodzącą** obok pierwszej i kartę **zastępującą** ją
w innym miejscu. Z pikseli to jest to samo pytanie.

**Dwie pomyłki po drodze, obie obalone danymi, nie przeczuciem:**

1. *Przyciąć pierwszą i ostatnią próbkę*, bo to karta w ruchu. Kosztowało prawdziwą drugą
   kartę, która akurat wjeżdżała pod koniec życia insertu. **Pozycja w czasie nie mówi nic.**
2. *Próg na przyroście pola.* Karta wjeżdżająca z dołu daje płynny narost, który wygląda jak
   nowa karta. Rozróżnia je **rozmiar względem największego, co w tym insercie widziano** —
   karta w trakcie rysowania jest ułamkiem siebie.

**Wynik:** 2 + 2 + 1 + 1 + 2 = **8 obrazów, tyle co u nich.** Cztery testy przypinają geometrię
(ten sam obraz / karta pod spodem / karta zastępująca / karta na wpół narysowana), więc żadna
z tych trzech pomyłek nie wróci po cichu.

### Karta wyników po tej zmianie

| | my | oni |
|---|---|---|
| słowa scenariusza | **67/67** | 67 |
| przerwy napisów | **21** | 22 |
| obrazy przypięte do mowy | **8** | 8 |

## 4g. Bramka na trzech formatach — i co się pod nią zawaliło (22.09)

Media referencyjne pobrane z ich własnych opublikowanych załączników (README linkuje je jako
`github.com/user-attachments`). Nasz dotychczasowy materiał okazał się jednym z nich. Który
plik jest referencją, rozstrzygnął **pomiar długości**, nie kolejność w pliku.

| | słowa | przerwy napisów | obrazy | plansza |
|---|---|---|---|---|
| ranking (tabela) | **67/67** | 21/22 | **8/8** | 5 rzędów, zmierzone |
| podcast (bez tabeli) | 67/69 | **17/17** | 0/0 | **żadnej** |
| street interview (bez tabeli) | 82/91 | 31/42 | 0/0 | **żadnej** |

### Trzy rzeczy pękły, gdy tylko przestaliśmy patrzeć na jeden film

**1. Pipeline wymyślał tabelę na podcaście.** Rzędy powstawały, gdy model *wskazał* planszę
**albo** skan ją zmierzył — czyli wystarczyło, że model powie „tu jest tabela", i dostawaliśmy
pięć równych rzędów i kolumnę szerokości jednej szóstej, których nikt nie policzył. Na
podcaście kończyło się to blueprintem odrzuconym przez własny walidator.
**Teraz rzędy powstają wyłącznie z pomiaru.** Skan jest testem, nie opinią: albo w tym filmie
jest siatka równych rzędów, albo jej nie ma. Gdy jej nie ma, uczciwym wyjściem jest film bez
planszy — bo tym ten film jest.

**2. Napisy brały się wyłącznie z tego, co zobaczył pass wizyjny.** Film, w którym capture nie
odczytał treści napisów, dostawał pustą taśmę. Teraz, gdy to, co trzyma pasmo, nie ma związku z
tym, co słychać, **treść napisu bierze się ze ścieżki dźwiękowej**. Napis odczytany z EKRANU
jest lepszy — tam napisy są — więc reguła odpala tylko wtedy, gdy nie ma czego odczytać.

**3. Porównywanie „czy to prawdziwy napis" na zbiorze słów dało się nabrać.** Atrapa „a line of
the narration" zawiera „a", „of", „the", które padają w każdym nagraniu, i przeszła jako
prawdziwy napis. Rozstrzyga **kolejność**: porównujemy pary sąsiadujących słów. „hair gel",
„gel than", „than trophies" występują w mowie w tej kolejności; atrapa nie ma czym tego udać.
Po tej zmianie podcast poszedł z 2/17 na **17/17**.

### Nowa kolumna w bramce: „plansza"

Sześć z siedmiu filmów w zestawie nie ma żadnego rankingu. Rząd zgłoszony w którymś z nich nie
został zmierzony, tylko **rozpoznany** — pipeline znalazł kształt filmu, na którym go
zbudowano. To najtańsza kolumna w całej bramce i łapie najgorszy rodzaj błędu.

## 4h. Narzędzie (22.09)

`agent-os-module/scripts/clone-film.mjs` — jedno wywołanie od filmu do filmu.

```
node agent-os-module/scripts/clone-film.mjs --source <id|ścieżka> --slug moj-film --film
```

`--host` podmienia prowadzącego (to jest ta podmiana, po którą całe narzędzie istnieje),
`--still` rysuje puste pudełka bez pytania dostawcy o obrazki — najtańszy sposób sprawdzenia,
czy format wyszedł, `--keep-cast` odtwarza obsadę oryginału zamiast bezimiennych zastępników,
`--capture` podaje opis treści, a bez niego pipeline dostaje wyłącznie „jest prowadzący i jest
pasmo napisów" i **całą resztę musi zmierzyć**.

Wszystko, co wygeneruje, leży obok projektu, więc drugie uruchomienie kosztuje tyle co pierwsze
uruchomienie minus generowanie.

**Sprawdzone na dwóch formatach:** film z tabelą (18 regionów, plansza 5 rzędów, 24 tweeny,
zero pustych slotów) i podcast bez tabeli (2 regiony, **żadnej planszy**, napisy wzięte ze
ścieżki dźwiękowej i pocięte na 33 porcje wobec zmierzonego rytmu 32).

### Dwie rzeczy, które narzędzie musiało umieć, a nie umiało

**Prowadzący nie może być dziurą.** Region oznaczony „wytnij" bierze się z oglądanego filmu —
a jeśli nikt go nie wycina, w klonie jest pusto dokładnie tam, gdzie patrzy widz.

**Wycinek nie może nieść cudzych napisów.** Pudełko prowadzącego sięga niżej niż pasmo napisów,
więc proste wycięcie przynosiło **wypalony napis oryginału**, a nasz własny rysował się na nim —
dwa napisy przechodzące przez siebie. Cięcie zatrzymuje się teraz nad literami, i nic na tym
nie tracimy, bo ten pasek i tak zasłania nasz własny napis.

## 4i. Bramka ma próg (22.09)

„Wszystkie evale przechodzą" nic nie znaczy bez progu, więc próg jest zapisany w kodzie:

| miara | próg | dlaczego taki |
|---|---|---|
| słowa | ≥ 90% | wszystko zakotwiczone w mowie stoi na tym; brakująca dziesiąta część scenariusza to napis mówiący coś, czego nikt nie powiedział |
| przerwy napisów | ≥ 70% | rytm formatu przeżyje cięcie spóźnione o słowo, ale nie połowę brakujących cięć |
| obrazy przypięte do mowy | co do sztuki | to liczba rzeczy; pomyłka o jeden znaczy kartę zgubioną albo wymyśloną |
| plansza | zero wymyślonych | najtańsza kolumna w zestawie, łapie najgorszy błąd |

`node agent-os-module/scripts/eval-text.mjs` kończy się kodem 1, gdy którykolwiek przypadek
spadnie poniżej. Dziś: **5 z 5 ocenianych przypadków nad progiem**.

## 4e. Notatki na następną gałąź — „długi film → shorty"

To jest **inna gałąź niż klonowanie formatu** i nasza macierz ma tam dziurę. Mamy w cache trzy
materiały 8–21 min, na których nie ma czego klonować — jest co **wyciąć**.

- **OpenShorts (MIT, wolno wołać ich kod):** `layout_picker` — wybór kadru z zamkniętego
  zbioru zamiast pomiaru; `camera_inset` — ta sama rzecz znaleziona geometrycznie, po tym jak
  pytanie o nią psuło celność z 92% na 83%. To jest gotowa odpowiedź na „jak ustawić kamerę,
  żeby mieściła się w pionie".
- **video-use:** cięcie na granicach słów z zapasem 30–200 ms (**już mamy**), napisy na samym
  końcu łańcucha (**już mamy jako regułę twardą**), cache transkryptu per źródło (**już mamy**).
- **Czego nie wolno przenieść z gałęzi klonowania:** założenia, że jest plansza, że są kafelki,
  że jest jeden prowadzący. Bramka negatywna (szczebel 3) istnieje właśnie po to.

## 5. Czego ten plan świadomie nie robi

- Nie przepisuje IR na język znaczników. Rozszerzamy istniejący kontrakt o cztery obszary.
- Nie rusza warstwy pomiarowej — zweryfikowana wobec autorskich liczb Hypita, działa.
- Nie zajmuje się dźwiękiem ani generowaniem assetów. Osobny temat, po tym.
- Nie dotyka `omniwatchTranscript.ts` — działa.

## 6. Co robić przed kompaktem sesji, a co po

Granica kompaktu jest prawdziwą zmienną kosztową, nie „ja czy agent".

**Subagent jest tani**, gdy ma dużo przeczytać i mało oddać (research: 36 MB repo → strona).
**Subagent jest drogi**, gdy zadanie potrzebuje kontekstu, który orkiestrator już ma — musi go
odtworzyć od zera. Miara z 21.09: pięć agentów researchowych, ~850 tys. tokenów, zero dostarczeń
(dlatego protokół z §1).

| kiedy | co | kto | dlaczego |
|---|---|---|---|
| **przed kompaktem** | A3 — kontrakt IR | sesja główna | jedyny artefakt drogi do odtworzenia po utracie kontekstu: mieści pięć awarii z 21.09 i wnioski z trzech repozytoriów |
| **po kompakcie** | A1, A2 | sesja główna | mechaniczne, zero decyzji architektonicznych, ~godzina; A1 zwraca się od razu (każdy render 5× szybszy) |
| **po kompakcie** | B1, B2, B3 | trzy subagenty (Sonnet) | właściwy kształt: rozłączne pliki, własne czytanie, mały deliverable; kontrakt z A3 zdejmuje z nich decyzje projektowe |
| **po kompakcie** | C1, C2 | sesja główna | integracja wymaga oglądania klatek i oceny „czy to wygląda dobrze" |

`omniwatchRecipe.ts` ma **jednego właściciela** — sesję główną. Pakiety B zgłaszają potrzebne pola,
scalenie robi orkiestrator. Rozbijanie pliku na obszary to refaktor na zapas.

---

## 7. Kolejność, gdyby robić to bez równoległości

A1 → A2 → A3 → B1 → B2 → B3 → C1 → C2. A1 i A2 dają natychmiastowy zysk bez żadnej decyzji
architektonicznej.
