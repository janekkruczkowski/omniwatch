# Trzy architektury klonowania wideo — co z nich bierzemy

**Data:** 2026-09-21 · **Czytane z pierwszej ręki** (sklonowane repozytoria, nie streszczenia).

> **Uzupełnienie 2026-09-22.** Rozpoznanie i wnioski poniżej są nadal aktualne, ale
> **kolejność prac z §5 jest już wykonana** — kontrakt renderera, aligner wpięty w ścieżkę
> klonowania, ruch jako decision list i kafelek ze stanem. Zdanie z §4, że ścieżka klonowania
> nie wywołuje alignera, jest **nieaktualne**: wywołuje. Co stoi dzisiaj, czego nie ma i ile
> to kosztowało — `agent-os-module/docs/STAN.md`. Bramki z pomiarami i odrzucone hipotezy —
> `agent-os-module/docs/GRAPH-PLAN.md`.

Kontekst: budujemy pipeline, który ogląda krótki film, wyciąga z niego **format** i renderuje
nowy film w tym formacie. Ma działać automatycznie, w naszej własnej pętli agentowej — użytkownik
nie podpina swojego Claude'a ani Codexa, tylko dostaje gotowca. Przewaga: Qwen Omni widzi obraz,
słyszy dźwięk i zna czas w jednym natywnym wywołaniu.

---

## 1. Hypit — `github.com/hypit-ai/hypit`

**Licencja:** zmodyfikowany Apache 2.0. Zabrania multi-tenant SaaS i odsprzedaży pochodnych.
Kodu **nie bierzemy**; niezależna implementacja architektury jest poza zasięgiem licencji.

Agent kodujący pisze **SVML** — język znaczników opisujący konkretny film jako program. Potem
`swap-host` / `swap-topic` / `swap-effect` to edycje tego programu.

`examples/ranking-football/` to **nasz film referencyjny**. Ich autorskie liczby vs nasze
zmierzone z pikseli zgadzają się do jednego–dwóch procent (kolory S–D, tło planszy, rozmiar
litery 0.3 vs 0.31, radius 0.12, pozycja stage'a 0.2/0.3). **Warstwa „patrz i mierz" jest dobra.**

Czego ich język umie powiedzieć, a nasz IR nie:

| obszar | Hypit | my |
|---|---|---|
| czas | zakresy przypięte do **słów** (`@{id}…@{/id}`), segmenty, cięcia captiona (`\|\|`), lead/tail, handoff | sekundy |
| przestrzeń | `Frame`, `AspectFrame` (x, y, width + aspekt pliku), `Extent`, `anchor`, jawny `stack-order` | płaski `[x,y,w,h]` |
| ruch | `enter: pop\|bounce\|scale`, `enter-frames`, `easing`, `exit: fade\|scale`, `exit-amount` | brak |
| captiony | `karaoke: current`, `active-box-*`, `max-words-per-line`, `handoff` | rozmiar, obrys, porcje po znakach |
| komponent ze stanem | `TierItem preset\|entry="drop" during={segment}`, `stage-x/y/size`, `appear-sound`, `move-sound` | brak |
| B-roll | `during` + `frame` + `appearance` + `motion`; nakładanie przez `stack-order` | box i czas, bez ruchu |
| audio | `gain`, `fade-in/out`, `playback`, sfx | brak |

---

## 2. OpenShorts — `github.com/mutonby/openshorts`

**Licencja:** MIT (poza `cloud/`, która ma licencję komercyjną). Kod wolno brać.

Dwie doktryny, obie poparte pomiarem na korpusie 48 klipów.

### Pytaj model o decyzję, nie o pomiar

`layout_picker.py`, komentarz otwierający:

> „Cztery poprzednie podejścia prosiły model (albo heurystykę pikselową), żeby coś **ZMIERZYŁ**…
> Wszystkie cztery padły tak samo. To pyta o **samą decyzję**. Wariancja była w proszeniu o ciągły
> pomiar, nie w modelu: **kategoryczny wybór z zamkniętego zbioru jest stabilny**."

Wyniki: 94% / 92% / 96% w trzech przebiegach. Trzy rzeczy, którym przypisują wygraną:

1. **mocny default** — „*none is by far the most common correct answer… if unsure, answer none*";
2. **nazwanie dystraktorów** — rogowe logo, licznik subów, wypalone napisy „*są dekoracją*";
3. **usunięcie pytania, którego model nie widzi** — opcję `camera_inset` wycofali, bo psuła
   celność z 92% na 83–85%; `camera_inset.py` znajduje to samo geometrycznie bez fałszywych trafień.

### Model wypisuje listę decyzji, kod ją dociska

`edit_builder.py`: zamknięty słownik efektów (`zoom_in`, `punch_in`, `zoom_pulse`, `color_pop`,
`bw_moment`, `flash`, `vignette`), każdy `{start, end, strength}`. Kod egzekwuje limity: max 12
edycji, min 0,15 s, max siła 0,15, **zero zoomów nad wypalonymi napisami**.

Plus dwa nawyki: **shadow mode** (decyduj, loguj, nie aplikuj) i **nigdy nie rzucaj** — każda
ścieżka błędu wraca do wartości domyślnej.

---

## 3. video-use — `github.com/browser-use/video-use`

**Licencja:** MIT. To skill dla Claude Code; Agent OS już go opakowuje (`/video-use`).

Filozofia **odwrotna do IR**:

> „LLM rozumuje z **surowego transkryptu** + wizualnych podglądów na żądanie. Jedyny artefakt
> pochodny, który zarabia na siebie, to spakowany transkrypt frazowy. Wszystko inne — tagowanie
> fillerów, wykrywanie dubli, klasyfikacja ujęć, ocena emfazy — **wyprowadzasz w momencie decyzji**."

Niezawodność siedzi w dwunastu **Hard Rules** („odstępstwo daje ciche awarie; to nie gust, to
poprawność"), reszta to wolność artystyczna. Wybrane, które nas dotyczą wprost:

- napisy **na samym końcu** łańcucha filtrów — inaczej nakładki je zasłonią (cicha awaria);
- **nigdy nie tnij w środku słowa**; każde cięcie na granicy słowa z transkryptu;
- **każde cięcie z zapasem 30–200 ms** — timestampy dryfują 50–100 ms;
- **tylko ASR na poziomie słów**, nigdy tryb frazowy (traci przerwy między słowami);
- cache transkryptu per źródło.

Ich lista anty-wzorców trafia w nas dwa razy: *„hierarchiczne, wstępnie liczone formaty z tagami —
przeinżynierowanie, wyprowadzaj z transkryptu w momencie decyzji"* oraz *„ręcznie strojone funkcje
oceniające — LLM wybiera lepiej niż jakakolwiek heurystyka, którą napiszesz"*.

Rzemiosło animacji, wprost przydatne:

- **HyperFrames jest ich rekomendowanym silnikiem** dla kompozycji HTML/CSS/GSAP — czyli nasz;
- **synchronizacja puenty**: weź timestamp słowa-puenty i zacznij nakładkę `reveal_duration`
  wcześniej, żeby klatka lądowania trafiła w to słowo — *„bez tego animacja jest odklejona"*;
- **nigdy `linear`** — `ease_out_cubic` dla pojedynczych wejść;
- **nigdy nie odsłaniaj dwóch niezależnych rzeczy naraz** — jedna, pauza, druga. (To dokładnie
  zachowanie dwóch kart u Hypita, które zmierzyliśmy jako „box rośnie".)
- trzymaj ostatnią klatkę ≥ 1 s; nad lektorem czas ≥ narracja + 1 s.

---

## 4. Jeden wniosek, który łączy wszystkie trzy

**Nigdy nie pytaj modelu o wielkość ciągłą.**

Ta sama awaria wraca w trzech niezależnych miejscach:

| gdzie | pytanie ciągłe | czym się kończy | kto odpowiada dobrze |
|---|---|---|---|
| OpenShorts | „jaki procent kadru zajmuje treść" | 1% i 97% w kolejnych przebiegach | kategoria z zamkniętego zbioru |
| my, dziś | „jaki rozmiar ma caption" | 0,028 vs zmierzone 0,038 | skan pikseli |
| my, dziś | „czy format kurczy caption" (z jednej klatki) | „shrink", a prawda to „chunk" | druga klatka + porównanie |
| Omni, wg testów Groka | „o której sekundzie pada to słowo" | drobne rozjazdy napisów | aligner (Scribe / WhisperX) |

Stąd podział pracy na **trzy instrumenty**, każdy tylko do tego, w czym jest dobry:

- **Omni** — znaczenie i struktura: co to za format, co się dzieje, w jakiej kolejności, co jest
  czym. Kategorie i listy decyzji z zamkniętych słowników.
- **Piksele** — wszystkie liczby geometryczne. Zweryfikowane: nasze pomiary = autorskie liczby Hypita.
- **Aligner** — czas słów. **Mamy go już** (`omniwatchTranscript.ts`, ElevenLabs Scribe,
  `timestamps_granularity: word`, plus gotowe `cuesFromWords` / `alignCues`) — ale ścieżka
  klonowania go **nie wywołuje**; używa go tylko trasa `/api/omniwatch/captions`.

Nagłówek tego pliku, napisany w którejś wcześniejszej sesji, formułuje to sam:

> „Layout bierze się z patrzenia, a czas napisów ze słuchania — każdy instrument odpowiada na
> pytanie, w którym jest dobry."

### Co to znaczy dla naszego IR

Spór Hypita (bogaty język) z video-use (minimum artefaktów) rozstrzyga się nie po jednej stronie:

- **Struktura potrzebuje pola.** Rzecz, która ma *miejsce i czas życia* — plansza, która się
  zapełnia; karta, która ląduje w rzędzie — musi być wyrażalna, bo inaczej reguła ją skasuje.
  Dziś zdarzyło się to pięć razy.
- **Rzemiosło potrzebuje reguły, nie pola.** Jakie easing, jak długo trzymać kartę, czy napisy idą
  ostatnie — to są Hard Rules egzekwowane w kodzie, nie pola w schemacie do wypełnienia przez model.

---

## 5. Kolejność prac, która z tego wynika

1. **Kontrakt renderera** — zarejestrować timeline GSAP. Zmierzone: render 1 min 47 s → **21,6 s**
   (setup 46,6 → 2,3 s), bo bez GSAP-a HyperFrames nie umie deduplikować statycznych klatek.
   Niezależne od reszty.
2. **Podłączyć aligner do ścieżki klonowania** — czasy słów zamiast dzielenia po znakach. Kod jest,
   brakuje wywołania. To zamyka rozjazdy napisów i daje kotwice dla insertów.
3. **Ruch jako decision list** — Omni wypisuje `{type, start, end, strength}` z zamkniętego zbioru,
   kod dociska limity (wzorzec `edit_builder.py`) i renderuje GSAP-em. Synchronizacja puenty wg
   reguły video-use.
4. **Kafelek ze stanem** — `preset` vs `entry: drop`, okno czasowe z segmentu, stage przy głowie.
   To jest ta rzecz, która nadaje filmowi sens.

Punkty 3–4 to **pytania dorzucone do tego samego wywołania Omni**, nie nowy pipeline.
