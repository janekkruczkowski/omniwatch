# HANDOFF — OmniWatch clone pipeline (Hypit / tier-list)

> **Dokument historyczny — oznaczono 2026-09-22.** Aktualny stan: [STAN.md](agent-os-module/docs/STAN.md).
> Odłożony szkic techniczny (priorytety nieuzgodnione): [ZADANIA.md](agent-os-module/docs/ZADANIA.md).
> Poniższe otwarte zadania i wyniki opisują moment powstania dokumentu.

**Data:** 2026-09-21 (Europe/Warsaw)
**Sesje:** Outer Loop (Grok Bot) + Janek → domknięcie (Claude Opus 5) + Janek
**Status:** **Pełny film z warstwą insertów.** Plansza, belka i caption mierzone z pikseli, compose rysuje wyłącznie z `recipe.json`, a inserty (zdjęcia kładzione na planszę) są mierzone i rysowane w swoich czasach.
Film: `.cache/outer-loop/film-v9/hypit-film-v9.mp4` (20,0 s, 600 klatek, 720×1280) + `recipe.json` obok.

Poprzednia wersja tego dokumentu kończyła się na „STOP na 1-frame proof, nie ma pixel-match".
Diagnoza Jana z §5 („za mało w recipe") okazała się trafna i ten dokument opisuje, co z niej wyszło.

---

## 1. Cel produktu (DoD) — bez zmian

Wejście: dowolny film (np. Hypit / HypeKit-style TikTok tier-list 9:16).
Wyjście: **własny** film o tym samym układzie UI, z **podmienionym hostem** i **czystymi assetami**.

| Warstwa | Źródło prawdy | NIE wolno |
|---|---|---|
| **Treść / timeline** | **Omni** (Qwen Omni) — *co* się dzieje, *kiedy* skacze layout | Omni **nie** rysuje geometrii, CSS, fontów |
| **Geometria (boxy)** | **Gemini 3.8 Flash** (`google/gemini-3.8-flash`, OpenRouter) — locate `box_2d` ze **źródłowych klatek**, a potem **skan pikseli** tam, gdzie da się policzyć | Nie mierzyć z naszego szablonu |
| **Wygląd (recipe)** | **Drugi pass Gemini** → `recipe.json`, **nadpisywany przez pomiar** | Mean-pixel z ROI tekstu/thumbs |
| **Rysowanie** | **Compose → HyperFrames HTML** — tylko wykonuje recipe | Compose nie zgaduje stylu |
| **Host (underlayer)** | **Czysty swappable 9:16** pod belką i nad planszą (cover) | Crop źródła z wypaloną belką |
| **Sloty** | Kwadratowe thumbs, radius tylko na obrazkach; rzędy S–D = ostre pastelowe prostokąty | Radius na label plates |
| **Assety** | Wygenerowane / czyste placeholdery OK | — |

**Walidacja tania:** najpierw **1 klatka** (`snapshot --at 0.5 --against source.mp4`), potem film.

---

## 2. Gdzie leży kod

| Ścieżka | Rola |
|---|---|
| `/Users/janek/Documents/agent-os/source/` | **Live Agent OS** (`localhost:3000`) |
| `.../video-watch/agent-os-module/` | Moduł źródłowy — **edytować tutaj**, potem `./install.sh` |
| `.../video-watch/` | Publiczne OmniWatch + ten handoff |

### Kluczowe pliki (clone)

| Plik | Odpowiedzialność |
|---|---|
| **`src/lib/omniwatchRecipe.ts`** | **NOWY.** Kontrakt `FormatRecipe` (pełne authored IR), `normalizeRecipe` (przeżyje każdy śmieć od modelu), `recipePrompt`, `applyMeasure` (pomiar > model), `applyRecipe`, `FACE_STACKS` / `FACE_WIDTHS` / `faceFromWidth`, `CAP_OF_EM` |
| **`src/lib/omniwatchBoardScan.ts`** | **NOWY.** Deterministyczny skan pikseli: `scanBoard` (siatka rzędów, kolumna liter, fille, kafelki i ich liczba), `scanPlate` (krawędzie belki), `scanInkLines` (box i cap-height liter), `readPixels` |
| `src/lib/omniwatchGround.ts` | Locate Gemini + orkiestracja: skan → recipe pass 2 → `fitTypeToInk` → `applyRecipe` → `fitSlotItemsToTiles` |
| `src/lib/omniwatchCompose.ts` | Blueprint + recipe → HTML. Komponent rzędu (plate + litera + N kafelków), typografia z recipe |
| `src/lib/omniwatchMeasure.ts` | Loci → refine ze źródła → merge treści → **ponowne** nałożenie recipe i liczby kafelków |
| `src/lib/omniwatchClone.ts` | `/api/omniwatch/clone`; recipe z pomiaru albo z requestu, zapisywane do projektu |
| `src/lib/omniwatchBlueprint.ts` | Walidacja. **Szablon TierList9x16 jest teraz opt-in** (`snapTemplate: true`) |
| **`scripts/proof-frame.mjs`** | **NOWY.** Jeden strzał: measure → recipe → compose → snapshot `--against` |

Env: `OPENROUTER_API_KEY` (czytane też z `~/.hermes/.env`). Override modelu: `GROUND_MODEL`.

---

## 3. Architektura pipeline (stan aktualny)

```
source.mp4
    │
    ├─ Omni (opcjonalnie) ──► content + timeline loci        NIE style, NIE boxy
    │
    ├─ Gemini locate (pass 1) ──► box_2d: banner, caption, board, inset
    │
    ├─ SKAN PIKSELI (nowy) ──► to, co da się policzyć:
    │      scanBoard  → siatka rzędów, kolumna liter, rowGap, fille S–D,
    │                   kolor slotu i planszy, rozmiar/gap kafelków, ICH LICZBA
    │      scanPlate  → dokładne krawędzie i kolor belki
    │      scanInkLines → box liter i cap-height (caption i belka)
    │
    ├─ Gemini recipe (pass 2) ──► recipe.json
    │      dostaje pomiary jako FAKTY, których nie wolno mu podważyć;
    │      odpowiada tylko na to, w czym jest dobry (krój, kolor obrysu, czy jest plate)
    │
    ├─ applyMeasure ──► pomiar nadpisuje model wszędzie, gdzie oba mają zdanie
    ├─ fitTypeToInk ──► rozmiar typografii z cap-height, krój z mierzonej szerokości liter
    ├─ fitSlotItemsToTiles ──► rząd dostaje tyle itemów, ile kafelków policzono
    │
    ├─ Guards: sanitizeCaptionVsBanner, fillPresenterBetween → flushBannerToTop,
    │          ensureInsetAlias, drop board-overlay, re-apply recipe PO merge
    │
    └─ Compose → HyperFrames → snapshot 1 klatki --against
```

**Zasada:** model odpowiada na pytania o **znaczenie** („co to jest", „jaki to krój"), skan na pytania o **liczby**. Wcześniej oba szły do modelu i stąd brały się stałe w CSS.

---

## 4. Co zostało zmierzone zamiast zgadnięte

Na klatce referencyjnej Hypita (720×1280, t=0.5 s):

| Wielkość | Było (zgadnięte) | Jest (zmierzone) |
|---|---|---|
| Kolumna liter S–D | 0.16 szerokości planszy | **0.2389** (172/720 px) |
| Rzędy | 5 równych podziałów planszy | pitch **114 px**, rowGap **4 px**, plansza bleeduje poza dolną krawędź |
| Fille S–D | paleta wymyślona | `#ec5d4f #ed9f4b #eec74c #eae254 #a6da7a` |
| Litera na plate | display/condensed, ~0.85 rzędu | **grotesque 400**, cap 0.22 rzędu → **0.31 rozmiaru** |
| Kafelki | flex + `!important`, zawsze 3 | 0.964 wysokości rzędu, kwadrat, gap 4 px, **1/1/2/2/3** |
| Belka | dosuwana do y=0 | plate **[0, 0.0328, 1, 0.0742]**, nad nią jest kadr |
| Caption | stroke „około 3 px", rozmiar od modelu | cap **35 px** → rozmiar 0.038, stroke 5 px, krój poprawiony na condensed-black |
| Host | 560×560 + pad → letterbox | cover **[0, 0, 1, boardTop]** |
| Caption przy długim zdaniu | kurczony do ~1/3 rozmiaru | **porcje po ~27 znaków**, stały rozmiar — jak w źródle |
| Tło napisu na belce | biały plate na kremowym pasku | brak — słowa siedzą na pasku regionu |

**Dowód:** `.cache/outer-loop/recipe-frame-v6/snapshots/pair-00-at-0.5s.jpg` + `recipe.json` obok.

---

## 4a. Po co to jest — rama produktu (korekta Jana, 2026-09-21)

Cel **nie jest** kopią 1:1 cudzego filmu ani „podepnij swojego Claude'a".

> Research na YouTubie → widzimy, że konkurent zrobił coś dobrego → chcemy wiedzieć **jak** →
> robimy coś podobnego **pod swoim kątem**. Człowiek wrzuca film konkurencji jako *format* i
> dostaje wyprodukowanego gotowca. Nie rozmawia z żadnym agentem kodującym.

Pętla agentowa w środku (LangGraph / LangChain) jest **jak najbardziej w porządku** — różnica
wobec Hypita jest taka, że u nich agent kodujący jest **wymaganiem po stronie użytkownika**, a
u nas ma być szczegółem implementacyjnym. Przewaga, na której stoimy, to Omni: obraz, dźwięk i
czas w jednym natywnym wywołaniu, zamiast pipeline'u klatki + Whisper + model kodujący.

Drugi case (inny, później): wyciąć z długiej prezentacji fragmenty i zrobić z nich shorty w
**gotowym już** formacie. Najpierw jednak wyciąganie formatu.

Do zbadania jako cegiełki (inspiracja, nie kod — licencje!): **OpenShorts**
(`github.com/mutonby/openshorts`, podobno sprytny w wykrywaniu filmu i doborze formatu) oraz
**VideoUse** (montaż agentami). Hypit: `github.com/hypit-ai/hypit`.

---

## 4b. Co Hypit ma w `examples/ranking-football` — i co z tego wynika

**To jest nasz film.** Ich `reference.svml` + `recipes.svs` opisują dokładnie tę tier-listę.
Porównanie ich **autorskich** liczb z naszymi **zmierzonymi z pikseli**:

| | Hypit (`recipes.svs`) | my (skan) |
|---|---|---|
| S/A/B/C/D | `#EE5F52 #F0A04C #F0C84D #EDE356 #A6DA7B` | `#ec5d4f #ed9f4b #eec74c #eae254 #a6da7a` |
| tło planszy | `#2B2B30` | `#2b2b2f` |
| rozmiar litery | `label-size: 0.3` | `0.31` rzędu |
| radius kafelka | `icon-radius-ratio: 0.12` | `0.11–0.12` |
| caption | `size: 44`, `max-words-per-line: 4` | cap 35 px → 48 px, ~4–5 słów |
| stage | `stage-x: 0.2, stage-y: 0.3, stage-size: 168` | inset-card środek (0.2, 0.3), 170 px |

**Wniosek: warstwa „patrz i mierz" jest dobra.** Wyprowadzamy z obrazu to, co oni wpisali ręcznie.

Brakuje czterech rzeczy — i żadna z nich nie jest pomiarem, tylko **słowem w naszym IR**:

1. **Kafelek z wejściem i oknem**: `<ranking:TierItem tier="d" entry="drop" during={segment.ronaldo}/>`
   — dziewięciu zawodników leży jako `preset`, dwóch omawianych **spada do swojego rzędu** w
   swoim fragmencie skryptu, z `appear-sound` / `move-sound`. To jest „obrazek ląduje na
   odpowiednim miejscu", o które pytał Janek. `stage-*` to nasza ramka przy głowie: ikona czeka
   tam, zanim spadnie.
2. **`motion.*`** jako osobny słownik: `enter: pop|bounce|scale`, `enter-frames`, `easing`,
   `exit: fade|scale`, `exit-amount`.
3. **Kotwiczenie w słowach**, nie w sekundach: w skrypcie `@{hair-gel} … @{/hair-gel}` wyznacza
   czas insertu, a `||` wyznacza cięcia captiona. My liczyliśmy porcje po znakach.
4. **Jawny `stack-order`** per element (40–47 dla kolejnych kart, 70 dla captionów).

Licencja: czytamy strukturę, **kodu nie bierzemy**. Ich licencja (zmodyfikowany Apache 2.0)
zabrania multi-tenant SaaS i odsprzedaży pochodnych; niezależna implementacja architektury jest
poza jej zasięgiem.

---

## 4c. Warstwa insertów — i czego nas nauczyła

Oryginał nie jest statyczną planszą pod gadającą głową. Co 2–3 sekundy kładzie na planszę
zdjęcie: żel do włosów obok pucharu, grecki posąg, zmockowany Instagram „Penaldo" z 679 mln
obserwujących, Maradona z pucharem. **To jest ten film.** Omni zapisał wszystkie pięć, z
czasami, pod id `board-overlay` — a kod kasował je w **trzech** miejscach (compose, merge
treści, filtr regionów), bo kiedyś jedna klatka miała pod tym id kopię planszy i napisano na
to regułę. Reguła przeżyła swój powód.

Teraz: insert jest mierzony osobno (klatka z jego czasu minus plansza = karta), dostaje własny
box (`BlueprintItem.rect` — nowe pole), a insert, którego box **rośnie** w trakcie swojego
czasu, to dwie karty wjeżdżające po kolei i jest dzielony na dwie. Kasowane jest tylko to, na
co regułę pisano: overlay pokrywający całą planszę, czyli jej kopia.

### Wniosek, który jest ważniejszy od tej jednej warstwy

`PLAN.md` (2026-09-20) postawił diagnozę: *„Ograniczeniem nie jest renderer ani jakość modelu,
tylko **reprezentacja**"*. Ta sesja potwierdziła ją trzy razy, zawsze tym samym mechanizmem:

| objaw | czego IR nie umiał powiedzieć | co zrobił kod |
|---|---|---|
| inserty nie istniały | „ten obrazek, **tutaj**, o tej sekundzie" | skasował track jako „junk" |
| caption w trzech rozmiarach | „ten format pokazuje po kilka słów, nie kurczy" | zmniejszał tekst do 1/3 |
| zawsze 3 kafelki | „ten rząd ma 2 kafelki" | flexbox z `!important` |

Za każdym razem brakujące pole w schemacie zamieniało się w **regułę, która kasuje albo
przybliża**. Każde z trzech rozszerzeń (`item.rect`, `caption.overflow`, liczba kafelków)
natychmiast przywracało brakującą warstwę. Następnym razem, gdy coś „nie działa jak u nich",
pierwsze pytanie brzmi: **czy IR w ogóle umie to wyrazić?** — a nie „czy dobrze mierzymy".

---

## 5. Czego skan NIE robi (świadomie)

Skan potrafi powiedzieć „tu nie ma planszy" i to robi. Sprawdzone na czterech filmach z cache
(`Fz89dJTZsko`, `StKa9LhH_-k`, `t5c28Hsvr_8`, `ymgH8jS6Wb8`): żaden nie jest tier-listą i na żadnym
nie powstaje pomiar — wcześniejsza wersja „mierzyła" ścianę za prezenterem jako pięć rzędów.

Próg akceptacji (generyczny, bez stałych z Hypita): rzędy muszą mieć **tę samą wysokość**
(spread ≤ 0.25) i **ten sam pitch** (spread ≤ 0.2), pokrywać ≥ 0.5 znalezionego boxu, a rząd z
> 12 „kafelkami" to tekstura, nie kafelki. Jak któryś warunek nie przechodzi → `null` i zostają
wartości z modelu.

---

## 6. Co zostało do zrobienia

1. **Zoom / ruch insertu.** Karty są rysowane statycznie w swoim boxie. W źródle niektóre
   wjeżdżają i się powiększają — to jest mierzalne (box na początku vs na końcu czasu), ale
   wymaga animacji w compose, a renderer trzeba najpierw sprawdzić pod tym kątem.
2. **Karaoke pill.** `recipe.caption.karaoke` jest w kontrakcie, compose go rysuje (pigułka na
   ostatnim słowie porcji — tak robi źródło), ale nic go nie mierzy: na klatce t=0.5 pigułki
   nie ma, więc pomiar z jednej klatki mówi „null". To samo lekarstwo co przy `overflow` —
   sprawdzić na drugiej klatce, gdzie pigułka jest.
3. **N layoutów z loci.** `measureBlueprint` przyjmuje listę `at` i zbiera segmenty, ale przy
   skoku geometrii (np. inset ~0:18) nie ma jeszcze przełączania layoutu w czasie w compose.
4. **Treść per kafelek.** `fitSlotItemsToTiles` rozmnaża item na tyle kafelków, ile policzono —
   ale wszystkie dostają ten sam opis. Rozbicie „Three images side-by-side: A, B, C" na trzy
   osobne podmioty to robota dla Omni (treść), nie dla recipe.
5. **Ścieżka dźwiękowa.** Film jest niemy — `audioUrl` w compose jest, ale nic go nie podaje.
6. **Prawdziwy 9:16 host generate** zamiast banana-placeholdera.
7. **Czas porcji captiona** jest dzielony proporcjonalnie do długości tekstu, bo nie mamy
   timingów słów. Transkrypt (`omniwatchTranscript.ts`) by to poprawił.

---

## 7. Jak odtworzyć dowód (Mac)

```bash
# jedna klatka
node agent-os-module/scripts/proof-frame.mjs \
  --blueprint .cache/outer-loop/bp-sharp.json \
  --assets .cache/outer-loop/gen-faces/asset-map.json \
  --slug hypit-recipe-v7 --at 0.5

# kilka momentów + cały film
node agent-os-module/scripts/proof-frame.mjs \
  --blueprint .cache/outer-loop/bp-sharp.json \
  --assets .cache/outer-loop/gen-faces/asset-map.json \
  --slug hypit-film-v6 --frames 0.5,5,10,15,19 --film
```

Skrypt puszcza **prawdziwy** pipeline (ten sam measure, to samo recipe, ten sam compose co serwer),
nie potrzebuje Agent OS na :3000, i kończy się parą `render | reference`. Wypisuje po drodze każdy
pomiar — jak coś wyjdzie krzywo, w logu widać którą liczbę obwiniać.

Testy:

```bash
node --test agent-os-module/test/recipe.test.mjs agent-os-module/test/style.test.mjs
```

`recipe.test.mjs` syntezuje planszę jako surowe piksele (bez fixture'ów) i sprawdza, że skan ją
liczy, że odmawia, gdy planszy nie ma, że recipe przeżywa dowolne śmieci od modelu i że compose
rysuje dokładnie to, co w recipe. Cała suita: 112 testów, zielona (przed tą sesją 8 padało).

---

## 8. Pułapki (zaktualizowane)

1. **Merge treści kasuje recipe** → `measureBlueprint` nakłada recipe **i liczbę kafelków** po merge.
2. **Szablon TierList9x16** — teraz **opt-in** (`validateBlueprint(bp, { snapTemplate: true })`).
   Domyślnie nie rusza geometrii, bo geometria jest mierzona. Włączenie go na zmierzonym
   blueprincie cofa pomiar (banda o połowę za niska, plansza dzielona równo).
3. **Caption MOŻE nachodzić na planszę** — w źródle nachodzi. Sanitizer odrzuca tylko caption,
   który zaczyna się poniżej górnej krawędzi planszy albo wchodzi na belkę.
4. **Kolejność guardów:** host kryje kadr **przed** decyzją o dosuwaniu belki. Odwrotnie belka
   dostaje „nic za mną nie ma" i skacze do y=0.
5. **Cap height ≠ font-size.** Wszystko, co zmierzone w pikselach liter, dzieli się przez
   `CAP_OF_EM` (0.72). Bez tego litera wychodzi o jedną trzecią za mała.
6. **Skan liter łapie nie-litery** — biały laptop 4 px nad białym captionem. Stąd test „ink musi
   mieć obrys w zasięgu" + wymóg zgodnej wysokości i pokrycia w poziomie dla kolejnej linii.
7. **Dwa drzewa kodu** (`agent-os-module` vs `agent-os/source`) — po zmianach `./install.sh`.
8. **Locate potrafi zwrócić transponowany box** ([ymin,xmin,…] czytane odwrotnie) albo nic.
   Skan jest instancją nadrzędną: próbuje boxu z locate, jego transpozycji, a na końcu szuka
   siatki po całej klatce — wygrywa ten, w którym faktycznie jest plansza.
9. **Pytania, na które nie da się odpowiedzieć jedną klatką**, trzeba mierzyć dwiema. Czy format
   kurczy caption, czy pokazuje go porcjami, widać dopiero gdy porówna się cap-height przy
   krótkim i długim zdaniu (`measureCaptionOverflow`). Model z jednej klatki mówił „shrink",
   klatki mówią „chunk".
10. **Pozycja kafelka to `item.beat`, nie kolejność na liście.** Przy pełnym filmie rząd emituje
   wszystkie kafelki, jakie kiedykolwiek ma — liczenie po kolejności wypychało drugą turę na
   pozycje 4, 5, 6.
11. **`.it { inset: 0 }` vs kafelki** — kafelki nie mają już klasy `.it`, mają własną geometrię
   inline. W wygenerowanym HTML nie ma ani jednego `!important` (jest na to test).

---

## 9. Decyzje modelowe (skrót)

- Locate: **`google/gemini-3.8-flash`** (OpenRouter), fallback DashScope Qwen tylko bez klucza OR.
- Dwa passy (locate → recipe) lepsze niż jeden łączony — bez zmian.
- **Nowe:** trzeci „pass" nie jest modelem, tylko arytmetyką. Wszystko, co policzalne, liczy skan,
  a model dostaje to w prompcie jako fakty.
- Kroje: zamknięty zbiór kształtów (`grotesque`, `grotesque-black`, `condensed`, `condensed-black`,
  `rounded`, `serif`, `slab`, `mono`) → stacki CSS. Model nazywa kształt, pomiar szerokości liter
  koryguje wybór, jeśli się nie zgadza (`faceFromWidth`).

---

## 10. Ton / preferencje Jana

- Rozmawiać **po polsku**.
- Jak plan/mapa już jest → iść do DoD, nie dopytywać.
- Steal-like-an-artist: inspirować się Hypitem, nie klonować IP assetów.
- Czyste wygenerowane twarze / owoce — OK.
- Poprawki mają być **generyczne**, nie pod jedną klatkę: każda zmiana z tej sesji usuwa złe
  założenie, nie dostraja stałą.

---

## 12. Dokąd dalej — czytaj w tej kolejności

1. `RESEARCH-CLONE-ARCHITECTURES.md` — trzy architektury (Hypit / OpenShorts / video-use)
   czytane z repozytoriów, licencje, i wniosek: **nigdy nie pytaj modelu o wielkość ciągłą**.
2. `PLAN-CLONE-V2.md` — osiem pakietów w trzech falach, rozdzielonych po własności plików,
   z protokołem dla subagentów (piszą do pliku, raportują ścieżkę) i granicą kompaktu sesji.
3. `agent-os-module/docs/IR-CONTRACT-V2.md` — nasz kontrakt na cztery brakujące obszary:
   ruch, element ze stanem, kotwice słowne, jawna kolejność warstw.

Pierwsze dwie rzeczy do zrobienia nie wymagają żadnej decyzji architektonicznej:
**A1** (rejestracja timeline'y GSAP — zmierzone 1 min 47 s → 21,6 s na tym samym filmie) oraz
**A2** (podłączenie alignera, który leży gotowy w `omniwatchTranscript.ts`, a ścieżka klonowania
go nie wywołuje).

---

*Handoff zaktualizowany po domknięciu recipe + skanu i po researchu architektur (2026-09-21).*
