# Prompty dla Claude Code

Wklejaj po kolei, jeden na sesję/commit. Każdy zakłada, że folder `studio-redesign/` leży obok kodu (albo podaj ścieżkę).

---

### 0. Fundament (raz)

> Przeczytaj `studio-redesign/DESIGN.md` i `studio-redesign/tokens.css`. W `studio/web-app` wprowadź tokeny do Tailwinda 4 (fonty Geist / Geist Mono / Newsreader, kolory, radius 4 px, bez cieni). Przestyluj komponenty shadcn: `Button` (default czarny, outline z obrysem #111, destructive jak w DESIGN.md), `Badge` z wariantami `you | ok | bad | run | pay | free`, `Card` bez cienia. Dodaj słownik chipów stanów projektu z sekcji 4. Nie zmieniaj logiki ani API. Na koniec pokaż mi zmienione pliki.

### 1. Komponenty domenowe

> Na podstawie `DESIGN.md` §3 zbuduj w `src/components/studio/`: `StatusCard`, `DecisionCard`, `CostCard`, `ProcessStepper`, `WhoWorkedStrip`, `StepList`, `RoundsTimeline`. Wygląd bierz z `studio-redesign/screens/Szablon.html` i `screenshots/Szablon.png`. Propsy typuj na podstawie `src/lib/api.ts`. Bez danych na sztywno.

### 2. Akceptacja szablonu (najważniejszy ekran)

> Przebuduj ekran bramki `format` według `studio-redesign/screens/Szablon.html` (desktop) i `M-Szablon.html` (telefon). Kolejność: stepper → StatusCard → WhoWorkedStrip → [VideoCompare | DecisionCard + CostCard] → „Co dostajesz w tym szablonie” (TemplateContract) → RoundsTimeline → zwinięte szczegóły. VideoCompare: dwa `<video>` odtwarzane razem, znaczniki klatek z `evidence.preview.frames`. Spór z `rationale.designCritique` pokaż jako pytanie z dwiema odpowiedziami; wybór dopisz do `note` przy `reject`. Angielski tekst modelu tylko pod „Oryginał (EN)”. Puste sekcje ukryj.

### 3. Analiza wzorca (agenci na żywo)

> Zbuduj widok projektu szablonu w trakcie (`state: running`, przed bramką `format`) według `screens/Analiza.html`: wzorzec z ramkami znalezisk, `AnalystCard` ×5 + karta reżysera, `LiveFeed` z polem „Uwaga dla reżysera”. Dane z `runs` / `timeline`; jeśli backend nie daje jeszcze wyników per analityk, zrób komponenty z pustymi stanami i wypisz mi, jakich pól brakuje w API.

### 4. Akceptacja treści

> Przebuduj bramkę `content` według `screens/Tresc.html` / `M-Tresc.html`: scenariusz jako `ScriptLine` z klatką-dowodem (`evidence.claims[].frames`), zdania bez dowodu oznaczone i z akcją „Usuń”, `CostCard` z `money` i limitem z `budget`, przycisk „Zatwierdź i nagraj · {kwota}”.

### 5. Projekt w toku, gotowy film, zatrzymany

> Według `screens/WToku.html`, `Film.html`, `Zatrzymany.html` (+ wersje `M-`): w toku = „Teraz” + oś montażysta ↔ kontrola z `editReview.decisions` + `StepList`; gotowy film = player, werdykt krytyka (albo wyraźne „brak oceny krytyka”), przed/po montażysty, animacje z `render.motion`, koszt; zatrzymany = problemy z `issues` (1 linia PL) + 3 akcje (`revise` / `approve` / `cancel`) z kosztem.

### 6. Start, Shorty, Jak to działa

> Według `screens/Main.html`, `Shorty.html`, `JakToDziala.html` (+ `M-`): start z sekcją „Czeka na Ciebie” na górze i paskiem „Pierwszy raz?”, trzy wejścia, lista projektów i zapisane szablony; shorty z formularzem w jednym wierszu i kartami `ShortCard`; statyczna strona „Jak to działa” pod `/app/jak-to-dziala` z linkiem w nawigacji.

### 7. Kontrola

> Porównaj każdy przebudowany ekran z odpowiednim `screenshots/*.png` przy szerokości 1440 i 390 px. Wypisz różnice w układzie, kolorach i tekstach, popraw je. Sprawdź brak poziomego przewijania na telefonie i cele dotyku ≥ 44 px.
