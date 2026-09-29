# Kontrakt IR v2 — cztery obszary, których dzisiejszy schemat nie umie powiedzieć

**Data:** 2026-09-21 · **Pakiet A3** z `PLAN-CLONE-V2.md`
**Podstawa:** `RESEARCH-CLONE-ARCHITECTURES.md` + pięć awarii z tej sesji.

To jest **nasz** kontrakt: własne nazwy pól, własne domyślne wartości, własny podział
odpowiedzialności. Struktura montażu (ścieżki, klipy, wejścia, warstwy) jest wspólnym dobrem
branży i starsza niż którykolwiek z badanych projektów; chronione są cudzy kod i cudze teksty
promptów, a tych nie bierzemy.

---

## 0. Dlaczego ten dokument istnieje

Pięć razy w ciągu jednej sesji ten sam mechanizm:

| objaw | czego IR nie umiał powiedzieć | co zrobił kod |
|---|---|---|
| inserty nie istniały | „ten obrazek, **tutaj**, o tej sekundzie" | reguła kasowała cały track jako „junk" — w **trzech** miejscach |
| caption w trzech rozmiarach w jednym filmie | „ten format pokazuje po kilka słów, nie kurczy" | zmniejszał tekst do 1/3 |
| zawsze 3 kafelki w rzędzie | „ten rząd ma 2 kafelki" | flexbox z trzema `!important` |
| karty stoją, choć w źródle wjeżdżają | „ta karta wchodzi z podskokiem przez 6 klatek" | rysował statycznie |
| ikona nie ląduje w swoim rzędzie | „ten kafelek leży od początku, a tamten dopada w swoim oknie" | wszystkie leżały od zawsze |

**Reguła naczelna kontraktu:** kiedy czegoś nie da się wyrazić, **nie wolno napisać reguły, która
to kasuje albo przybliża**. Wolno: dodać pole albo zgłosić brak i zostawić dziurę widoczną.

---

## 1. Kto wypełnia które pole

Każde pole w tym dokumencie ma przypisany **instrument**. Przypisanie jest wiążące — pole
wypełnione przez zły instrument jest błędem kontraktu, nie kwestią jakości.

| instrument | wypełnia | nigdy nie wypełnia |
|---|---|---|
| **Omni** | kategorie z zamkniętych zbiorów, listy decyzji, przynależność (co jest czym, co po czym) | wielkości ciągłe: rozmiary, procenty, sekundy |
| **Piksele** (`omniwatchBoardScan`) | każdą liczbę geometryczną i kolor | znaczenie |
| **Aligner** (`omniwatchTranscript`, Scribe, word-level) | czasy słów i granice cięć | cokolwiek wizualnego |
| **Kod** (stałe, limity) | wartości domyślne i dociskanie zakresów | nic, co da się zmierzyć |

Dowód, że podział działa: nasze zmierzone liczby dla filmu referencyjnego zgadzają się z
autorskimi liczbami zewnętrznego projektu do 1–2% (kolory rzędów, rozmiar litery, radius,
pozycja stage'a). Dowód, że łamanie podziału nie działa: Omni zapytany o rozmiar captiona
odpowiedział 0.028 przy zmierzonym 0.038, a zapytany z jednej klatki „czy format kurczy napis"
odpowiedział „kurczy", choć film pokazuje porcjami.

---

## 2. Obszar I — ruch (`move`)

Dzisiaj: brak. Element albo jest, albo go nie ma.

### `item.arrival` / `item.departure`

```ts
interface Move {
  /** Z zamkniętego zbioru. Omni wybiera nazwę, nigdy nie podaje liczb. */
  shape: "cut" | "fade" | "pop" | "drift" | "swell";
  /** Ile trwa. Kod dociska do zakresu; Omni tego nie podaje. */
  seconds: number;
  /** Krzywa. Nigdy liniowa — to jest reguła kodu, nie wybór modelu. */
  ease: "soft-out" | "soft-in-out" | "overshoot";
  /** 0..1, siła efektu (dystans przy drift, skala przy pop/swell). Kod dociska. */
  amount: number;
}
```

| `shape` | co robi | typowe użycie |
|---|---|---|
| `cut` | pojawia się natychmiast | element, który ma nie zwracać uwagi |
| `fade` | tylko krycie | wyjście insertu |
| `pop` | skala od mniejszej, z przeskoczeniem | karta B-roll wchodząca na planszę |
| `drift` | wjazd z przesunięciem | element wjeżdżający z boku |
| `swell` | skala w górę bez przeskoczenia | spokojne wejście szerokiej karty |

**Zakresy dociskane przez kod** (nie do negocjacji przez model): `seconds` 0,08–0,6;
`amount` 0–0,35; maksymalnie **jeden ruch na element**; ruch nigdy nie przekracza połowy czasu
życia elementu.

**Gdy brak:** `{ shape: "cut", seconds: 0, ease: "soft-out", amount: 0 }` — czyli dzisiejsze
zachowanie. Kontrakt jest addytywny: stary blueprint renderuje się dokładnie jak dziś.

**Kto wypełnia:** `shape` — Omni (kategoria). `seconds`, `amount`, `ease` — kod (domyślne per
`shape`), opcjonalnie skorygowane pomiarem, gdy porównanie dwóch klatek pokaże skalę wejścia.

**Renderowanie:** `omniwatchMotion` zamienia `Move` na tween GSAP. Mechanizm potwierdzony:
HyperFrames trzyma spauzowaną timeline'ę sterowaną przez runtime i wspiera `opacity, x, y,
scale, rotation, width, height, visibility`.

---

## 3. Obszar II — element ze stanem (`hold`, `waitsAt`)

Dzisiaj: kafelek albo leży od początku filmu, albo wcale. Stąd plansza, która się nie zapełnia.

### `item.hold`

```ts
type Hold =
  | "from-start"   // leży od pierwszej klatki — tło formatu
  | "on-cue";      // dopada w swoim oknie i zostaje do końca
```

### `item.waitsAt`

```ts
/** Id regionu, w którym element CZEKA, zanim zajmie swoje miejsce.
 *  Null / brak = pojawia się od razu na miejscu docelowym. */
waitsAt?: string;
```

To opisuje zachowanie, które w naszym filmie referencyjnym nadaje całości sens: ikona omawianego
podmiotu pojawia się przy głowie prowadzącego, a potem **ląduje w swoim rzędzie**. Bez tych dwóch
pól plansza jest statyczną tapetą, a widz nie wie, czego dotyczy zdanie.

**Przejście `waitsAt` → miejsce docelowe** jest `Move` (§2) i podlega tym samym limitom.

**Gdy brak:** `hold: "from-start"`, `waitsAt` puste — dzisiejsze zachowanie.

**Kto wypełnia:** `hold` i `waitsAt` — Omni (kategoria i przynależność: „ten podmiot jest
omawiany w tym fragmencie"). Geometria stage'a i rzędu — piksele. Okno czasowe — aligner (§4).

### LUKA, którą obnażyła integracja (21.09, po C1)

Ten paragraf opisuje **gdzie** element czeka, ale nie **jak długo**. Implementacja wzięła
moment lądowania = `item.start` — czyli element pojawia się i od razu jedzie. W filmie
referencyjnym ikona **stoi przy głowie prowadzącego przez kilka sekund** i dopiero potem
spada, i to ta pauza niesie sens: widz ma czas skojarzyć ikonę ze zdaniem.

Do wyrażenia tego brakuje jednej liczby — momentu lądowania, osobnego od momentu pojawienia
się. Zgodnie z regułą naczelną z §0 **nie zaklejam tego regułą** („ląduje zawsze 2 s po
pojawieniu") ani nie zgaduję w kodzie. Propozycja pola, do dodania razem z tym, co je
wypełni:

```ts
/** Sekunda, w której element zajmuje swoje docelowe miejsce. Brak = `item.start`,
 *  czyli dzisiejsze zachowanie: wjeżdża od razu. Wypełnia aligner (§4) z okna słów,
 *  w którym pada werdykt — nie Omni, bo to jest czas. */
landsAt?: number;
```

Dopóki go nie ma, klon oddaje **ruch** (ikona wjeżdża do rzędu), ale nie **oczekiwanie**.

---

## 4. Obszar III — kotwice słowne (`cue`)

Dzisiaj: sekundy. Porcje captiona cięte po liczbie znaków, czasy insertów dzielone
proporcjonalnie do długości tekstu. Stąd rozjazdy.

### `item.cue`

```ts
interface Cue {
  /** Indeksy w transkrypcie słowo-po-słowie. Aligner, nie Omni. */
  firstWord: number;
  lastWord: number;
  /** Zapas na dryf timestampów, sekundy. Kod: 0,03–0,2. */
  pad: number;
  /** Ile WCZEŚNIEJ zacząć wejście, żeby klatka lądowania trafiła w ostatnie słowo.
   *  Bez tego animacja jest odklejona od zdania. */
  lead: number;
}
```

`item.start` / `item.end` pozostają — są wyliczane z `cue`, a nie wpisywane obok niego. Gdy
`cue` jest obecne, **ono jest źródłem prawdy**, a sekundy są pochodną.

**Gdy brak:** sekundy jak dziś.

**Kto wypełnia:** `firstWord` / `lastWord` — aligner plus dopasowanie tekstu, który Omni
przypisał do elementu. `pad`, `lead` — kod.

**Uwaga kosztowa:** aligner odpytujemy **raz na źródło** i cache'ujemy. Nigdy dwa razy dla tego
samego pliku.

---

## 5. Obszar IV — jawna kolejność warstw (`layer`)

Dzisiaj: `region.z`. Ale dwie karty w jednym regionie nachodzą na siebie i nie ma czym
powiedzieć, która jest na wierzchu.

### `item.layer`

```ts
/** Wyższy rysuje się później. Rozstrzyga nakładanie WEWNĄTRZ regionu.
 *  Brak = kolejność na liście. */
layer?: number;
```

**Kto wypełnia:** Omni (kolejność: „druga karta wchodzi na pierwszą"). Kod przydziela liczby.

---

## 6. Reguły, które NIE są polami

Te rzeczy nie należą do schematu — model nie ma ich wybierać. Idą do kodu jako testy
(`test/hard-rules.test.mjs`, pakiet C2):

1. Napisy rysowane **po** nakładkach — inaczej nakładka je zasłoni.
2. Żadne cięcie **w środku słowa**.
3. Easing **nigdy liniowy**.
4. Ostatnia klatka elementu trzymana ≥ 1 s przed zejściem.
5. Dwa niezależne elementy **nie pojawiają się jednocześnie** — jeden, pauza, drugi.
6. Ruch nigdy nie przekracza połowy czasu życia elementu.
7. Brak `!important` w wygenerowanym HTML — geometria idzie inline z recipe.
8. Element bez assetu zostaje **widoczną dziurą**, nie znika po cichu.

Punkt 5 nie jest estetyką: to on tłumaczy, dlaczego w źródle żel i puchar wjeżdżają osobno —
i dlaczego nasz pomiar zobaczył to jako „box rośnie w trakcie".

---

## 7. Sprawdzian kontraktu

Kontrakt jest dobry wtedy, gdy każda z pięciu awarii z §0 ma pole, które by ją wyraziła:

| awaria | pole |
|---|---|
| inserty nie istniały | `item.rect` (dodane 21.09) + `item.layer` (§5) |
| caption w trzech rozmiarach | `caption.overflow` (dodane 21.09) + `item.cue` (§4) |
| zawsze 3 kafelki | liczba kafelków w recipe (dodane 21.09) |
| karty stoją | `item.arrival` / `item.departure` (§2) |
| ikona nie ląduje w rzędzie | `item.hold` + `item.waitsAt` (§3) |

Trzy pierwsze już istnieją. Obszary II–IV są tym, co zostało.

---

## 8. Zgodność wsteczna

Każde pole w tym dokumencie jest **opcjonalne** i ma wartość domyślną równą dzisiejszemu
zachowaniu. Blueprint bez nowych pól renderuje się bajt w bajt tak samo. To nie jest uprzejmość
wobec starych plików — to warunek, żeby dało się wdrażać te obszary pojedynczo i po każdym
zobaczyć różnicę na jednej klatce.
