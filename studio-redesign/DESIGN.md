# Studio — projekt interfejsu (handoff dla Claude Code)

Źródło: kanwa „Studio — przeprojektowanie” (Claude Design), stan z 24.09.2026.
Cel: przebudować `studio/web-app` (React 19 + TS + Vite + Tailwind 4 + shadcn/ui + AI Elements) według makiet z `screens/`.

Makiety to statyczny HTML — **wzór wyglądu i hierarchii, nie kod do skopiowania**. Implementuj w komponentach React/shadcn, dane bierz z `src/lib/api.ts`.

---

## 1. Zasada UX (najważniejsze)

**Człowiek jest ostatnim ogniwem, nie poprawiaczem.** Każdy ekran projektu ma w 3 sekundy odpowiedzieć:

1. Co się dzieje i czy agenci się zgodzili (po ilu rundach; jeśli nie — o co spór).
2. Co mam teraz zdecydować.
3. Ile to kosztowało i ile będzie kosztować.

Szczegóły (rozumowanie modeli, surowe logi, JSON) — zawsze zwinięte (`<details>` / shadcn `Collapsible`), po polsku jako streszczenie, oryginał pod „Oryginał (EN)”.

Użytkownik ma **3 decyzje**: (1) szablon, (2) treść i koszt, (3) gotowy film. Płatne kroki (głos, prezenter) ruszają dopiero po decyzji 2.

---

## 2. Styl wizualny

Ciepły, „redakcyjny” styl: kremowe tło, cienkie nagłówki (300), ostre rogi 4 px, etykiety w monospace z szerokim rozstrzeleniem, jeden fioletowy akcent. Bez cieni, bez gradientów, bez zaokrągleń > 4 px (wyjątek: kropki i awatar użytkownika).

### Kolor = znaczenie (nie dekoracja)

| Znaczenie | Kolor | Użycie |
|---|---|---|
| Twoja kolej / decyzja | `#0007CB` fiolet | chip „Czeka na Ciebie”, znaczniki na osi wideo, numery decyzji, ramka „Tu jest spór”. Max 1–2 razy na ekran. **Nigdy jako wypełnienie przycisku.** |
| Płatne | `#6B4A0E` na `#F3E9D2`, pasek `#B98A2E` | chip „płatne”, kwoty za głos/prezentera |
| Zgoda / gotowe | `#2F6B4F` (obrys `#BCD3C4`) | „Gotowe”, „Zgoda po 2 rundach” |
| Spór / problem | `#A3261B` na `#F6E3DF`, obrys `#E3C4BE` | „Brak zgody”, „Zatrzymany”, przycisk „Porzuć” |
| Agenci pracują | `#111111` + pulsująca kropka | chip „W toku”, tekst z efektem shimmer |

Neutralne: tło `#FAF9F6`, len `#F1EEE9` (pod wideo, paski info), karty `#FFFFFF`, linie `#DEDBD6`, kamień `#D3CEC6`, tekst `#111111`, drugorzędny `#414141`, pomocniczy `#585858`, wyłączony `#888888`.

### Typografia

- **Geist** 300 — nagłówki (56–80 px na stronach, 40–44 px tytuł projektu, 20–32 px sekcje), letter-spacing −0.035em.
- **Geist** 400/500 — tekst (14–17 px). Pogrubienie = 500, nigdy 700.
- **Geist Mono** — etykiety (11 px, UPPERCASE, tracking 0.1em), chipy, liczby, czasy, kwoty (tabular-nums).
- **Newsreader** 300 — akapity wprowadzające i „cytaty” agentów (16–19 px).

Tokeny gotowe do wklejenia: `tokens.css` (Tailwind 4 `@theme`).

### Komponenty bazowe (mapowanie na shadcn)

| Element | Wygląd | shadcn |
|---|---|---|
| Przycisk główny | czarny `#000`, biały tekst, 4 px, min-h 44 | `Button` default |
| Przycisk drugorzędny | biały, obrys `#111` | `Button variant="outline"` |
| Przycisk niebezpieczny | przezroczysty, tekst `#A3261B`, obrys `#E3C4BE` | `Button variant="destructive"` przestylowany |
| Chip / tag | mono 11 px uppercase, h 24, 4 px | `Badge` z wariantami: `you`, `ok`, `bad`, `run`, `pay`, `free` |
| Karta | biała, obrys `#DEDBD6`, 4 px, bez cienia | `Card` |
| Przełącznik segmentowy | obrys, aktywny = czarne tło | `ToggleGroup` |
| Zwijane sekcje | wiersz 56 px, linia górna | `Collapsible` / `Accordion` |
| Nawigacja | tekst szary, aktywna = czarny + podkreślenie 2 px | `NavigationMenu` lub zwykłe linki |

---

## 3. Komponenty domenowe

Każdy występuje na kilku ekranach — zrób je raz.

1. **`StatusCard`** — karta stanu projektu. Chipy stanu (czeka / zgoda / spór / w toku / zatrzymany), tytuł 44 px, jedno zdanie po polsku „co się dzieje”, po prawej metryki (rundy, czas pracy, wydano z limitu). Warianty: `Szablon`, `Tresc`, `WToku`, `Zatrzymany`, `Analiza`.
2. **`WhoWorkedStrip`** — lniany pasek „kto tu pracował”: 2 agentów + „Ty” (fioletowy awatar) z jednym zdaniem każdy, link „Jak to działa →”. (`Szablon`, `Tresc`)
3. **`DecisionCard`** — czarny obrys, tytuł „Twoja decyzja”, opcjonalny blok sporu (pytanie + 2 odpowiedzi jako radio), pole „Uwaga dla agentów” z podpowiedziami, przyciski Zatwierdź / Odrzuć z uwagą (z kosztem odrzucenia), zdanie „co się stanie po kliknięciu”, link „Porzuć”.
4. **`CostCard`** — koszt: pozycje płatne (chip złoty + kwota) vs „grosze”, pasek udziału, suma dużą cyfrą, pasek limitu projektu (wydane / ten krok / limit), „Mieści się w limicie”.
5. **`VideoCompare`** — dwa filmy 9:16 obok siebie na lnianym tle, jeden przycisk „Odtwórz oba razem” (synchronizacja `currentTime`), oś z fioletowymi znacznikami klatek porównawczych, przełącznik „Pokaż miejsca do wypełnienia” (nakładka ramek slotów), ramka „Tu jest spór”.
6. **`TemplateContract`** — „Co dostajesz w tym szablonie”: miejsca (schemat kadru + lista z kosztem), styl napisów (żywa próbka wzorzec vs szablon + cechy), konstrukcja opowieści (4 bity), detale (zostaje / zmienione / pominięte + dlaczego), skąd co pochodzi (wzorzec / marka / odbiorca).
7. **`RoundsTimeline`** — oś rund pary agentów: numer, „Krytyk: …”, „Reżyser zmienił: …”, koszt rundy, zwinięty oryginał EN. Ostatnia runda przy braku zgody na czerwono z powodem końca.
8. **`AnalystCard`** — karta agenta-analityka (ekran `Analiza`): awatar z inicjałami (czarny = gotowy, obrys = pracuje), nazwa + „na co patrzy”, stan, wynik (cytat szeryfem / próbka / chipy / pasek postępu / bity), stopka czas · koszt.
9. **`LiveFeed`** — strumień „Na żywo” w stylu czatu: awatar, nazwa, godzina, jedno zdanie po polsku; wskaźnik „pisze…”; pole „Uwaga dla reżysera” na dole. Dane z runów/logów, streszczone.
10. **`StepList`** — lista kroków z czasem i kosztem (✓ / pulsująca kropka / przerywane kółko), płatne kroki z chipem, suma.
11. **`ScriptLine`** — wiersz scenariusza: czas, zdanie (wyróżnione słowo na złotym tle), dowód = klatka z materiału z czasem; wariant „brak dowodu” (przerywana złota ramka + „Usuń zdanie · −8 s”).
12. **`ProblemList` + `RecoveryActions`** (ekran `Zatrzymany`): numerowane problemy (1 linia + klatka), 3 karty akcji: Popraw (polecane) / Zaakceptuj mimo to / Porzuć — każda z kosztem.
13. **`ShortCard`** — player 9:16, chip układu (podział / za mówcą), czas i ocena, tytuł, hak, „Dlaczego ten moment”, Pobierz.
14. **`ProcessStepper`** — etapy w nagłówku projektu (✓ / aktywny fiolet / numer).

---

## 4. Ekrany → dane z API

| Ekran (makieta) | Kiedy | Dane (`src/lib/api.ts`) |
|---|---|---|
| `JakToDziala` | menu „Jak to działa”, pasek „Pierwszy raz?” na starcie | statyczne |
| `Main` (Start) | `/app/` | `GET /api/projects` (stan, koszt); sekcja „Czeka na Ciebie” = `state ∈ {awaiting_approval, needs_attention}` na górze; `GET /api/formats` → zapisane szablony |
| `Analiza` | projekt `mode:"template"`, `state:"running"`, przed bramką `format` | `runs[]`, `timeline.steps` (czas, koszt), logi analityków → `LiveFeed` (streszczenie PL) |
| `Szablon` | `pendingGate(view).scope === "format"` | `evidence.preview` (ref, frames), `evidence.template.slots` (label, paid, costNote), `rationale.caption`, `rationale.intents`, `detailInventory`, `rationale.designCritique` (`agreed`, `rounds[]`, `disagreement`, `openDisagreements`), `budget` |
| `Tresc` | `scope === "content"` | `evidence.claims[]` (text, frames), `money` (voice, presenter, totalUsd), `presenter.fits`, `rationale.length`, `rationale.critique.notes`, `issues` |
| `WToku` | `state:"running"` (film) | `timeline.steps`, `editReview.decisions[]` → oś montażysta ↔ kontrola, `budget` |
| `Film` | `state:"completed"` | `artifacts` (MP4 → `artifactUrl`), `rationale.critic` (verdict; brak → wyraźne „brak oceny krytyka”), `editReview.decisions` (przed/po), `render.motion[]` (animacje) |
| `Zatrzymany` | `state:"needs_attention"` | `issues[]` (blocking, detail) → 1 linia PL na problem; akcje: `POST /commands` revise / approve / cancel |
| `Shorty` | `/app/shorts` | `POST/GET /api/shorts` → `ShortsJob.result.shorts[]` (moment.title/hook/why/score, layout) |

Stany projektu → chip: `draft` Szkic · `queued` W kolejce · `running` W toku · `awaiting_approval` Czeka na Ciebie · `needs_attention` Zatrzymany · `completed` Gotowy · `failed` Błąd · `cancelled` Porzucony.

Komendy: Zatwierdź = `approve`; Odrzuć z uwagą = `reject` + `note`; wybór w sporze dopisz do `note` (np. „Spór: prezenter — jak chce krytyk”); Popraw = `revise`; Porzuć = `cancel`.

---

## 5. Język

Prosty polski, bez żargonu. Zamiany:

| Nie | Tak |
|---|---|
| slot | miejsce |
| gate | decyzja |
| QA | kontrola |
| evidence | dowód |
| render | składanie filmu |
| intent | zamysł |
| rationale | dlaczego tak |
| approve / reject | Zatwierdź / Odrzuć z uwagą |

Role agentów: Analitycy (kadr, napisy, montaż, opowieść, detale), Reżyser, Krytyk, Scenarzysta, Redaktor, Lektor (płatny), Prezenter AI (płatny), Montażysta, Kontrola. Użytkownik = „Ty” (producent).

Tekst modeli po angielsku nigdy nie jest pokazywany wprost — tylko polskie streszczenie + zwinięty „Oryginał (EN)”. Puste sekcje się ukrywa zamiast pisać „brak danych”.

---

## 6. Telefon

Wszystkie ekrany mają wersję 390 px (`screens/M-*.html`). Zasady: bez poziomego przewijania; wideo porównawcze obok siebie po 2 kolumny; przyciski decyzji przyklejone do dołu ekranu (Odrzuć 1/3, Zatwierdź 2/3); sekcje kontraktu szablonu i rundy zwinięte; cele dotyku ≥ 44 px.

---

## 7. Pliki

- `screens/*.html` — makiety (otwierają się w przeglądarce; linki między ekranami działają). `M-*` = telefon.
- `screenshots/*.png` — zrzuty pełnej strony każdego ekranu.
- `screens/img/` — klatki przykładowe użyte w makietach (do zastąpienia prawdziwymi danymi).
- `tokens.css` — tokeny Tailwind 4.
- `PROMPTY.md` — gotowe polecenia dla Claude Code, ekran po ekranie.
