# Przegląd projektu interfejsu studia

2026-09-22 · `omni/codex-handoff` · bazowy commit `e6ede85`.
Status bieżący: **DEFERRED_BY_USER**. Jan odłożył design: najpierw silnik i evale.
Roboczy mockup nie jest docelową propozycją wizualną. Poniższe ustalenia zachowano
jako zapis przeglądu, nie aktywne wymagania do akceptacji przed pracą nad silnikiem.
Dokument projektu: [UX.md](UX.md). Technika: [TECHNICAL](TECHNICAL.md).

## Zakres i metoda

Jan wywołał [design-review](/Users/janek/.claude/skills/gstack/.agents/skills/gstack-design-review/SKILL.md).
Opis skilla mówi: „For plan-mode design review (before implementation), use /plan-design-review.”
Bieżąca rozmowa dotyczy planu studia przed implementacją, więc użyto wskazanego
[plan-design-review](/Users/janek/.codex/skills/gstack-plan-design-review/SKILL.md).
To nie audyt wyglądu wdrożonej aplikacji. Nie oceniono CSS produktu na podstawie
makiety, nie zmieniano UI OmniWatcha i nie uruchamiano pętli commitów poprawek.

Wcześniejsza dyspozycja Jana: samodzielnie przygotować decyzje, następnie przedstawić
całość do akceptacji. Dlatego zakres, pełne siedem przebiegów i propozycje rozstrzygnięto
bez pytań o każdy szczegół. Nie oznacza to przyjęcia któregokolwiek nowego rozwiązania.
Dotychczasowa akceptacja planu inżynierskiego również pozostaje otwarta.

## Audyt przed przeglądem

- Plan opisuje nowe ekrany: wejście, projekt z podglądem i rozmową, formaty,
  akceptacje, stan i eksport. Nie jest zmianą wyłącznie backendową.
- Root DESIGN.md to historyczny dokument produktu. `gstack-design-md check`
  zwrócił `unknown: no front matter and no gstack legacy headings`. Nie ma
  normatywnego systemu tokenów studia. Nie nadpisano tego pliku.
- Odczytano CONCEPT, TECHNICAL, TEST-PLAN, stosowne fragmenty prototypu oraz wiki
  o bibliotece i trzech architekturach konkurencji. Własne nagranie Jana nie
  stało się pierwszym POC; kolejność Hypit → podcast → Qwen/Julian zachowana.
- GitHub PR base niedostępny: `error connecting to api.github.com`. Lokalny
  `origin/main` istnieje (`4bbac712…`); to fallback do kontekstu, nie zdalnie
  potwierdzona gałąź PR. Przedmiotem pozostają dokumenty, nie cały branch diff.
- Repo ma wcześniejsze niezacommitowane zmiany. Zachowano je; nie wykonano
  zbiorczego commita ani stashowania cudzej/niezwiązanej pracy.
- `gstack-review-read`: NO_REVIEWS w globalnym rejestrze; poprzedni przegląd
  inżynierski istnieje lokalnie. Cache gstack ponownie odmówił zapisu EPERM.
- Generator gstack/design/dist/design nie istnieje. Utworzono jeden klikalny
  szkic inline z wariantem rozmowy obok/pod podglądem. Nie wygenerowano PNG ani
  nie przypisano akceptacji makiet. Preambuła używała aktywnej nakładki gpt-6-astra.

## Step 0 — pierwsza ocena

Pierwsza ocena kompletności opisu UX: **4/10**. Wymagania określają sens podglądów,
bramek i rozmowy, ale nie układ ekranów, zachowanie pól ani dostępność. 10/10
wymagałoby zatwierdzonej hierarchii, kompletnego opisu stanów i przetestowania
makiet wszystkich krytycznych przepływów. To nie ocena estetyki istniejącego UI.

Największa korzyść z projektu: użytkownik nie musi rozumieć grafu. Widzi cel,
wynik i działanie, a ścieżka pracy zmienia się stosownie do gotowych materiałów.

## Pass 1 — architektura informacji: 5/10

**UX1 [P1, pewność 9/10].** TEST-PLAN §Affected Pages/Routes wymienia strony,
ale nie ustala pierwszej/drugiej/trzeciej informacji w projekcie. A, rekomendowane:
podgląd + treść/szczegóły + rozmowa oraz zakładki wyników; ASCII w UX §1.
B: kreator wszystkich etapów, łatwiejszy do opisania, lecz sugeruje obowiązkową
analizę/generację i powtarza zbędne kroki. A lepiej zachowuje opcjonalność umiejętności.

**UX2 [P1, pewność 9/10].** CONCEPT §2 rozdziela formę i treść, lecz użytkownik
nie ma opisanej możliwości poprawienia roli pliku. A, rekomendowane: role widoczne
przy każdym materiale i edytowalne w miejscu; agent je sugeruje. B: same wnioski
agenta w rozmowie, mniej kontrolek, większe ryzyko niewidocznej pomyłki źródeł.
Odbiór: referencja Juliana + demo Qwen oraz ten sam materiał w obu rolach.

## Pass 2 — stany interakcji: 4/10

**UX3 [P1, pewność 9/10].** CONCEPT §4 ma trzy różne bramki. Wspólny „Zatwierdź”
może oznaczać zgodę na format, koszt lub kompletny film. A, rekomendowane: nazwa
wyniku, wersja, jawne placeholdery, rezultat QA i przycisk nazwany skutkiem.
B: jeden podgląd i generyczne „Kontynuuj”, krócej, lecz znaczenie akceptacji znika.

**UX5 [P1, pewność 9/10].** TECHNICAL §6/8 opisuje budżet i nieznany submit,
ale nie początek pracy użytkownika bez skonfigurowanego providera ani zestawienie
kosztu. A: sprawdzanie tylko potrzebnych narzędzi, limit przygotowania, zbiorcza
bramka produkcji, rozliczono/zarezerwowano/pozostało. B: pełny setup z góry albo
komunikat dopiero po błędzie; oba podnoszą koszt rozpoczęcia. Rekomendacja A.

**UX7 [P2, pewność 9/10].** TEST-PLAN G18 wymaga czytelnego postępu, bez mapowania
`needs_attention` na działania. A: tabela stanów i komunikatów UX §7, rzeczywista
ścieżka, zachowane wyniki i celowana naprawa. B: wspólny spinner i „Spróbuj ponownie”,
co może sugerować powtórny koszt i nie wyjaśnia pominiętej analizy. Rekomendacja A.
Macierz w UX obejmuje loading/empty/error/success/partial, nie sam happy path.

## Pass 3 — przebieg pracy i oczekiwania: 6/10

**UX4 [P1, pewność 8/10].** CONCEPT §3/4 wymaga zrozumienia demonstracji/podcastu,
ale nie opisuje, jak człowiek sprawdzi zgodność wypowiedzi z materiałem.
A: pełny scenariusz, wybieralne sceny i przycisk do odpowiedniego źródła;
referencja formatu i źródło treści mają osobne podpisy/czasy. B: sam render i
streszczenie planu; prostsze, utrudnia wykrycie zmyślonego zdania przed generacją.
Rekomendacja A, bez panelu dowodów, gdy użytkownik dał tylko temat.

**UX6 [P1, pewność 9/10].** TECHNICAL §5 opisuje rewizje, lecz „powiększ napisy”
nie definiuje, czy zmienia odcinek czy bibliotekę. A: widoczny cel korekty,
domyślnie bieżący odcinek, świadomy zapis nowego formatu. B: automatyczna zmiana
szablonu z każdej rozmowy; mniej decyzji, ale niezamierzony wpływ na następne filmy.
Rekomendacja A; zwykłe odwracalne korekty nie dostają kolejnej obowiązkowej bramki.

| Krok | Użytkownik robi | Prawdopodobne oczekiwanie / obawa | Odpowiedź projektu |
|---|---|---|---|
| 1 | Otwiera Nowy film | Chce zacząć bez nauki narzędzi | Temat, format, opcjonalne materiały |
| 2 | Dodaje referencję i treść | „Czy agent rozumie, co jest czym?” | Widoczne role i jedno zdanie celu |
| 3 | Czeka na podgląd | Nie chce płacić za zgadywanie | Faktyczny postęp i limit przygotowania |
| 4 | Ocenia format | Chce ocenić ruch, nie nieruchomy obraz | Podgląd, referencja i jawne placeholdery |
| 5 | Czyta odcinek | Chce sprawdzić sens przed generacją | Pełne wypowiedzi i odnośniki do źródeł |
| 6 | Zatwierdza produkcję | Chce znać zakres i koszt | Jedna bramka z wersją i limitem |
| 7 | Wraca później | Nie chce zaczynać od nowa | Zachowany projekt i stan ostatniej pracy |
| 8 | Zgłasza poprawkę | Nie chce generować wszystkiego drugi raz | Cel zmiany, reuse, nowy podgląd |
| 9 | Odbiera MP4 | Chce pobrać to, co zaakceptował | Jednoznacznie przypięta wersja eksportu |

Emocje w tabeli są hipotezami projektanta, nie wynikami badania z użytkownikami.
Pierwsze 5 sekund: cel, wynik, działanie. Pierwsze 5 minut: tani podgląd i poprawka.
Powtarzane użycie: zapisane formaty, powrót do projektu i brak zbędnej generacji.

## Pass 4 — ryzyko generycznego UI: 4/10

Klasyfikacja: OPERATE. Nie znaleziono w bazowym planie nakazu zastosowania hero,
karuzeli ani siatki dekoracyjnych kart. Brak opisanej kompozycji nadal pozostawia
ryzyko przypadkowego dashboardu. Pokrywa je UX1/UX8; nie tworzymy duplikatu ustalenia.
Szkic ma prawdziwe kontrolki i celowo schematyczny podgląd. Nie udaje zrzutu filmu.

| Litmus | Szkic | Dowód / ograniczenie |
|---|---|---|
| Wiadomo, co to za produkt? | YES | Studio filmowe, projekt filmu i formaty |
| Jeden dominujący element? | YES | Centralny pionowy podgląd |
| Czytelne przy skanowaniu? | YES | Format / Treść odcinka / Film; konkretne działania |
| Każdy region ma jedno zadanie? | YES | Podgląd, treść/korekta, nawigacja, akceptacja |
| Karty mają uzasadnienie? | YES | Nie ma dekoracyjnej mozaiki; regiony wynikają z pracy |
| Ruch wspiera pracę? | NO | Szkic zmienia moment przyciskiem; płynny podgląd wymaga implementacji |
| Działa bez dekoracyjnych cieni? | YES | Hierarchię tworzy układ i tekst, bez cieni |

Hard rejection: 0 potwierdzonych w szkicu. Nie jest to automatyczna ocena A/B
produktu. Nie uruchomiono detektora renderu ani audytu produkcyjnego design-review.

## Pass 5 — system wizualny: 2/10

**UX8 [P2, pewność 9/10].** Brak tokenów studia; DESIGN.md opisuje inne warstwy
produktu. A: propozycja tokenów i komponentów UX §8, mapowanie do hosta; B:
bezpośrednie kopiowanie CSS OmniWatcha, szybsze, ale wiąże nowe studio z historią
innego UI i nie ustala standalone. Rekomendacja A; font dostarczony z aplikacją,
nie zależny od instalacji na komputerze. Nie oceniono pełnej zgodności z hostem.
Szkic korzysta z motywu rozmowy i może użyć fontu zastępczego; nie jest wzorcem fontów.

## Pass 6 — małe ekrany i dostępność: 2/10

**UX9 [P1, pewność 9/10].** TECHNICAL/TEST-PLAN nie określały rozkładu na małym
ekranie ani pełnej obsługi klawiaturą/czytnikiem. A: jedna aktywna powierzchnia
na telefonie, zachowana rozmowa/czas, jawny przełącznik, kontrolki i kryteria UX §8.
B: pomniejszony desktop i późniejsze poprawki; nie zapewnia czytelnego podglądu.
Rekomendacja A. Pierwszy użytkownik desktopowy nie uzasadnia niewidocznego fokusu.
44 px to cel projektu; nie opisujemy go błędnie jako minimum WCAG 2.2 AA.

## Pass 7 — rejestr decyzji

UX1–UX9 pozostają propozycjami do jednej zbiorczej akceptacji. Żadnego nie oznaczono
jako indywidualnie zatwierdzone. Przyjęcie zakresu przeglądu nie oznacza przyjęcia
rozwiązań. Koszt rekomendacji: umiarkowany opis UI teraz, mniej zgadywania podczas T8.
Alternatywy opisano w przebiegach; wszystkie dotyczą sposobu realizacji uzgodnionego celu.

| Decyzja | Jeśli pozostanie nieokreślona |
|---|---|
| UX1 — obszar pracy | Implementacja może pokazać graf lub obowiązkowy kreator |
| UX2 — role materiałów | Agent może pomylić referencję z treścią |
| UX3 — podglądy i akceptacje | Użytkownik zatwierdzi co innego, niż zamierzał |
| UX4 — kontrola treści | Błędy sensu wyjdą dopiero w drogim renderze |
| UX5 — gotowość i koszty | Nieoczekiwany setup lub rachunek |
| UX6 — zakres poprawki | Niezamierzona zmiana formatu albo ponowna generacja |
| UX7 — postęp i błędy | Brak drogi powrotu po przerwaniu pracy |
| UX8 — tokeny i komponenty | Rozjazd wyglądu między ekranami i hostami |
| UX9 — małe ekrany / a11y | Nieosiągalne lub nieczytelne działania |

## Niezależna kontrola

Natywny subagent Codex `studio_design_challenge` przeczytał CONCEPT, TECHNICAL
i TEST-PLAN bez kontekstu głównego przeglądu. Zwrócił pięć uwag: role źródeł P1,
znaczenie akceptacji P1, zakres korekty P1, dobór ścieżki w postępie P2 i konkretne
działania w needs_attention P2. Wszystkie mapują się do UX2/UX3/UX6/UX7, z kosztami
UX5. Nie powiększono sztucznie liczby ustaleń o duplikaty. Agent nie zmieniał plików,
zakończył pracę i został zatrzymany. Nie jest to opinia innego modelu ani audyt renderu.

Próba zewnętrzna Claude Code z pełnym tekstem UX (17 940 bajtów): `unavailable`,
`authentication`, exit 1, zero tokenów. Komunikat: „Claude Code authentication
failed. Run claude interactively in this execution context to authenticate.”
Sesja `aec25e97-3615-41e3-9230-db13b80f5798`. Nie powstała zewnętrzna opinia;
zachowujemy wynik natywny jako single-model. Pełny rekord ma dane użycia i sesji.

## Podsumowanie kompletności

Oceny odnoszą się do sześciu wymiarów planu przed nowymi propozycjami. Nie podnosimy
ocen na podstawie własnego szkicu bez akceptacji użytkownika. To skala heurystyczna.

| Wymiar | Przed | Po zatwierdzonych zmianach |
|---|---|---|
| Architektura informacji | 5/10 | 5/10 |
| Stany interakcji | 4/10 | 4/10 |
| Przebieg pracy | 6/10 | 6/10 |
| Konkretność zamiast generycznego UI | 4/10 | 4/10 |
| System wizualny | 2/10 | 2/10 |
| Responsywność i dostępność | 2/10 | 2/10 |
| Całość, minimum sześciu wymiarów | 2/10 | 2/10 |

Propozycja UX opisuje rozwiązanie wszystkich dziewięciu ustaleń; nie oznacza to
zatwierdzonego wyglądu ani przetestowania gotowej aplikacji. 7 przebiegów ukończonych,
0 nowych rozwiązań zatwierdzonych, 9 oczekujących. NOT in scope: cztery pozycje
w UX §9. Wykorzystanie obecnych rozwiązań: ten sam rozdział. Nowe niezależne TODO:
0. Implementacja i weryfikacja UX rozwijają T8/T13/T14, nie osobny projekt poboczny.
1 klikalny szkic, 0 zatwierdzonych makiet. Szczegóły prób i ograniczeń w rekordzie
`design-review-record.json`. Zadania: [DESIGN-TASKS](DESIGN-TASKS.md).

## Korekta priorytetu po pokazaniu szkicu

Jan uznał design za drugorzędny przed działającym silnikiem i wskazał, że szkic
wygląda jak techniczny prototyp, nie gotowy produkt. Wstrzymano dopracowywanie
mockupu, dalsze testy wizualne i rozbijanie UI na zadania do wykonania.
UX1–UX9 nie są warunkiem przyjęcia planu silnika. Role źródeł, wersjonowanie,
semantyka akceptacji, zakres korekt i rozliczenie mają pozostać w kontraktach
silnika niezależnie od przyszłego designu.

Przed korektą sprawdzono kilka symulowanych interakcji szkicu i układ przy
375 px. Nie był to test aplikacji, finalnego renderu ani pełny audyt dostępności.
Ostatnie drobne zmiany szkicu nie przeszły ponownego sprawdzenia w przeglądarce;
dalszą weryfikację zakończono zgodnie ze zmianą priorytetu.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| CEO | plan-ceo-review | Cel i zakres | 1 rozpoczęty | Nieukończony | Poprzedni lokalny zapis |
| Eng | plan-eng-review | Architektura i wykonanie | 1 | issues_open (PLAN) | D1–D12 czekają na zbiorczą akceptację |
| Design | design-review → plan-design-review | Projekt ekranów i przepływów | 1 | deferred_by_user | UX1–UX9 odłożone; nie blokują silnika |
| Native design | Subagent Codex | Kontrola kompletności | 1 | completed, single-model | 5 uwag pokrytych propozycjami |
| Outside design | Claude Code | Zewnętrzna kontrola | 1 próba | unavailable: authentication | Brak opinii zewnętrznej |
| Visual QA live | design-review | Wygląd rzeczywistej aplikacji | 0 | Nie wykonano | Właściwe po implementacji |

**VERDICT:** DEFERRED_BY_USER. Przegląd zachowany jako materiał roboczy;
docelowy design wróci po sprawdzeniu silnika. Brak statusu DESIGN CLEAR
nie blokuje prac technicznych. Plan inżynierski pozostaje do zbiorczej akceptacji.

**UNRESOLVED DECISIONS:**
- UX1–UX9: odłożone; nie wymagamy teraz ich akceptacji.
- + 1 unresolved from prior reviews: akceptacja pakietu D1–D12 przeglądu inżynierskiego.
