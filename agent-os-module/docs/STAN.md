> **Aktualny stan obu projektów — 2026-09-23:** [docs/STAN.md](../../docs/STAN.md). Poniższy dokument zachowuje historię wcześniejszych prac.

# Stan na 2026-09-22

> **Organizacja prac, 2026-09-22:** roboczy inwentarz techniczny, własność plików i warunki odbioru
> są w [ZADANIA.md](ZADANIA.md). **To odłożony szkic, nie uzgodnione priorytety:**
> użytkownik chce najpierw uporządkować projekt na szerszym poziomie. Poniższe wyniki to zapis wcześniejszych uruchomień;
> uzupełnienie z przeglądu kodu i testów znajduje się w §7.

Co mamy, co jest sprawdzone, co jest zepsute i co dalej. Wszystko, co niżej nazwane
„sprawdzone", było **uruchomione**, a nie odczytane z raportu.

---

## 1. Co to jest

Narzędzie, które ogląda krótki film pionowy, **mierzy jego format** i renderuje nowy film
w tym samym formacie. Trzy przyrządy, każdy odpowiada tylko na swoje pytanie:

| przyrząd | odpowiada na | nigdy nie odpowiada na |
|---|---|---|
| **Omni** (`qwen3.8-omni-flash`) | co to jest — kategorie, struktura | żadnych wielkości ciągłych |
| **piksele** (własne skany) | gdzie to jest — cała geometria | — |
| **aligner** (`scribe_v1`) | kiedy to pada — czasy słów | — |

Reguła naczelna: **od modelu nigdy nie bierzemy liczby ciągłej.**

Wejście: `scripts/clone-film.mjs`. Bramki: `scripts/eval-text.mjs` (tania, tekstowa) i
`scripts/eval-generate.mjs` (droga, renderująca).

---

## 2. Co działa — z dowodem

**Graf z bramkami.** Trzy etapy, które i tak sprawdzały swój wynik, mają jeden kształt
(`omniwatchNode.ts`: `accepts` / `retry` / `onGiveUp`): przemiatanie planszy, pasmo napisów,
chodzenie po spanie insertów. Każdy przebieg wypisuje raport — która bramka, która próba,
co ostatecznie zwróciła. *Dowód: raport pokazał, że przemiatanie planszy ratuje przebieg na
drugiej próbie, czego wcześniej nie było widać nigdzie poza logiem.*

**Biblioteka szablonów.** Format da się zapisać (`--save-template`) i odtworzyć
(`--from-template`) bez otwierania filmu. *Dowód: zbudowany film z zapisanego szablonu przy
**ffmpegu zdjętym ze ścieżki** — 18 regionów, plansza 5 rzędów, „no film opened, no model
asked".*

**Klon z prawdziwymi zdjęciami.** 21 z 23 obrazków z Groka, format się trzyma: plansza,
portret w rogu, karta profilu w dziewiątej sekundzie, napis na krawędzi planszy, baner.
Dwa kafelki odbite limitem kie.ai zostały **widocznymi dziurami**, nie cichymi zastępnikami.

**Bramka tekstowa — 5/5**, wszystkie trzy formaty:

```
ranking     słowa 100%   cięcia 21/22
podcast     słowa  97%   cięcia 17/17
wywiad      słowa  90%   cięcia 31/42     ← najsłabszy
```

**Bramka generowania — 8 przypadków zamiast 2.** Renderuje klon na tanich ścieżkach, mierzy
render z powrotem i porównuje strukturę ze źródłem. Wypisuje werdykt po każdym przypadku
i staje na pierwszej porażce (`--all` wymusza całość).

**`landsAt`** — ikona czeka przy prowadzącym i dopiero potem spada; moment lądowania
z progu pauzy policzonego z filmu.

**226 testów**, zielone.

---

## 3. Co jest zepsute

### 3.1 Punkt odniesienia się rusza — to jest najpoważniejsze

Bramka generowania: **4 z 8 przypadków poniżej progu**, kod wyjścia 1.

```
✗ podcast--swap-app      warstwy: źródło [figure, text]         render [figure, figure, text]
✗ interview--swap-host   warstwy: źródło [figure, text]         render [figure, figure, text]
✗ interview--swap-lang   napis: dryf 1.117 > 0.08
✗ interview--swap-lang   warstwy: źródło [figure, figure, text] render [figure, text]
✗ interview--swap-ride   warstwy: źródło [figure, figure, text] render [figure, text]
```

Kierunki są **przeciwne**, a to ten sam film i ten sam capture. Wywiad zmierzony trzy razy
dał `[figure, text]` raz i `[figure, figure, text]` dwa razy. Rozjeżdża się nie render, tylko
**punkt odniesienia**. Ewaluacja, która mierzy od zera przy każdym przebiegu, mierzy między
innymi własny szum.

### 3.2 Pochodzenie nie zastępuje sensu

Przy `swap-lang` źródłowe pasmo napisów wyszło jako `[0.381, 0.211, 0.201, 0.032]` — 20%
szerokości kadru, 3% wysokości, w górnej ćwiartce. W pionowym filmie to nie jest pasmo
napisów. Bramka **przyjęła to**, bo pudełko ma `origin` — model faktycznie odpowiedział.

**Pochodzenie mówi, czy ktoś zmierzył. Nie mówi, czy odpowiedź ma sens.** Drugiej bramki nie ma.

### 3.3 Bramka generowania jest pusta na filmach bez planszy

Podcast i wywiad nie mają planszy ani insertów, więc dwie z czterech kolumn porównują zero
z zerem. Gryzie tylko kolejność warstw i dryf napisu. Na tych formatach bramka broni mniej,
niż się wydaje — to, że złapała cztery rozjazdy, nie znaczy, że złapałaby piąty.

### 3.4 Wywiad: 26 kawałków wobec ich 45

**Nie jest to kwestia położenia pasma.** Trzy metody sprawdzone i odrzucone:

- przerwy nie stoją w pauzach mowy (0,060 s w cięciu wobec 0,080 s wewnątrz kwestii);
- normalizacja progu po zapisanych kolumnach nic nie daje (96/96 wszędzie);
- zgodność zmian z granicami słów nie różnicuje (mediana 0,060 s niezależnie od pasma).

Skan tuszu działa, ale jest zgrubny: na rankingu trafia w wiersz, pudełko ma dwa razy za
wysokie; na wywiadzie **zwraca dziurę** — i niezależny pomiar potwierdza, że słusznie.

Został jeden niesprawdzony trop: detektor zbocza scala dwie zmiany krótsze niż 0,1 s w jedną.

---

## 4. Koszty

| dostawca | co robi | dziś |
|---|---|---|
| **OpenRouter** (`gemini-3.8-flash`) | lokalizacja regionów | **$4,69**; na koncie zostało **~$10,83** |
| **kie.ai** (Grok) | obrazki | 23 żądania, 21 dostarczonych; zostało **894,31** kredytu |
| **DashScope** (Omni) | — | **zero** — capture z nagranego pliku |
| **ElevenLabs** | — | **zero** — czasy słów z cache |

Klucz OpenRoutera jest współdzielony z Hermesem, więc te $4,69 nie musi być w całości nasze.
Stanu kie.ai sprzed dzisiejszego przebiegu nie znam — 894,31 jest zapisane jako punkt
odniesienia na przyszłość.

---

## 5. Co dalej, w kolejności

1. **Mierzyć raz, jechać na szablonie.** Biblioteka jest gotowa; bramka generowania nadal
   mierzy źródło przy każdym przypadku. Przestawienie jej na zapisany szablon usuwa 3.1
   u źródła — porównanie przestaje mieć ruchomy punkt odniesienia.
2. **Bramka sensowności obok bramki pochodzenia.** Pudełko napisu musi pomieścić linię,
   którą niesie, przy zmierzonym rozmiarze liter. To jest mierzalne i generyczne, i łapie
   3.2 bez zaklęcia „napisy są na dole".
3. **Kolumna, która coś mierzy na filmach bez planszy** — dziś 3.3 przepuszcza z definicji.
4. **Wywiad**: sprawdzić scalanie sąsiednich zmian. Jeśli nie to, przyjąć, że zmierzony rytm
   jest najlepszym dostępnym oszacowaniem, i zapisać to jako granicę metody.
5. Czatowe poprawianie szablonu — szew jest zostawiony i pusty.

---

## 6. Rzeczy do zapamiętania o samej pracy

**Nic nie jest zacommitowane** — 39 plików w drzewie roboczym, zgodnie z poleceniem.

**Agentom nie wierzymy na słowo.** Dwie paczki zgłosiły sukces, a wywalały bramkę: nowy moduł
nie był na ręcznie pisanej liście ładowania w pięciu skryptach. Loader czyta teraz importy
z kodu — lista, którą trzeba aktualizować w pięciu miejscach, nie jest listą.

**`node ... | tail` zwraca kod `tail`.** Awaria bramki wyglądała przez to jak `EXIT=0`.

**Ewaluacja jest powtarzalna, bo capture leży w pliku.** Omni nie jest pytany po raz setny
o ten sam film. To jest konstrukcja, nie oszczędność przez przypadek.

## 7. Uzupełnienie z przeglądu organizacyjnego — 2026-09-22

Przeczytano 12 stron `.omc/wiki`, kontrakt i aktualne skrypty. Powtórzono testy z plików
`node`, `template`, `motion`, `stage`, `recipe`, `cues`, `style`, `capture-prompt`,
`hard-rules`, `band-scan`, `measure-origin`, `prompt` (`*.test.mjs`): **exit 0**.
To wybrany zestaw, nie ponowne potwierdzenie wszystkich historycznych 226 testów.
Raportów 5/5 i 4/8 nie przeliczano; nie uruchamiano renderów ani płatnych pomiarów.

Odczyt kodu doprecyzowuje wcześniejsze wnioski:

- Zapisany capture stabilizuje wejście Omni, ale nie cały pomiar. Obie bramki mogą
  wejść w grounding; `eval-text.mjs` nie jest z definicji offline.
- Bramka tekstowa nie sprawdza `scored.length === 0` przed sukcesem. Obie bramki
  mogą raportować awarię wykonania jako nieoceniony przypadek, poza listą `failed`.
- Bramka generowania nie przekazuje nowej treści do CLI w przypadkach `swap-*`.
  Nazwa przypadku nie jest dowodem podmiany. Wynik 4/8 dotyczy obecnego testu struktury.
- Przy braku lokalizacji i wyniku skanu pasma Measure zachowuje wejściowy prostokąt
  z ostrzeżeniem `origin: guess`. Nie jest to równoważne usunięciu zgadywanej geometrii.

Porównanie `agent-os-module/src` z `/Users/janek/Documents/agent-os/source/src`:
**58 plików identycznych, 6 różnych, 3 brakujące w instalacji**.
Różne: `omniwatchGround.ts`, `omniwatchBlueprint.ts`, `omniwatchCompose.ts`,
`omniwatchMeasure.ts`, `omniwatchCues.ts`, `omniwatchStage.ts`.
Brakujące: `omniwatchBandScan.ts`, `omniwatchNode.ts`, `omniwatchTemplate.ts`.
To porównanie zawartości, nie ocena, która wersja zawiera lepsze poprawki.

Przed edycją dokumentacji `git status --porcelain=v1 -uall` wykazał **69 plików**;
wcześniejsze „39” należy czytać jako historyczny snapshot. Kopie handoffu były
identyczne bajtowo. Historia pozostaje zachowana; dodano nawigację do aktualnego stanu.
