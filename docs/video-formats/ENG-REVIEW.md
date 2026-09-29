# plan-eng-review — studio filmowe

2026-09-22 · branch `omni/codex-handoff` · bazowy commit `e6ede85`.
Przedmiot: CONCEPT.md, GRAPH-DECISION.md i EVAL-PLAN.md po korektach Jana.
Wynik: [TECHNICAL.md](TECHNICAL.md). Wyłącznie przegląd i dokumentacja.

## Tryb i Step 0

Zakres wynika z bieżącej rozmowy; nie ocenialiśmy diffu całego OmniWatcha.
Wcześniejsza wyraźna dyspozycja Jana o autonomicznych decyzjach i akceptacji
całości zastępuje pytania skilla przy każdym problemie. D1–D12 są propozycjami,
nie zmyślonymi zgodami użytkownika. Nie stwierdzamy gotowości do implementacji.

Oceniono alternatywy: dopinanie scenariuszy do obecnego endpointu, modułowe
wydzielenie z LangGraph, nowy silnik od zera. Rekomendacja: druga opcja [Layer 1],
z wykorzystaniem obecnych instrumentów. Pełny zakres funkcji zachowany; infrastruktura
ograniczona do jednego pakietu i lokalnego hosta. Ośmiu modułów nie wydajemy jako usług.
README/STAN/CLONING i bieżące docs zastępują zimny cache pamięci. AGENTS/TODOS
w repo nie znaleziono; nie wyciągano z tego braku nowych wymagań użytkownika.

## 1. Architecture — 6 ustaleń

### D1 [P1] (pewność 9/10) — niezależne budowanie i wydanie

Motywacja: GRAPH-DECISION.md:161 „Osobny worker wykonuje długą pracę”.
Obecny `scripts/clone-film.mjs:96`: `createRequire(path.join(AGENT_OS, "package.json"))`.
To działający lokalny bootstrap, ale nie dowód samodzielnego runtime'u.
Rekomendacja A: jeden pakiet `studio/`, własne zależności, API/worker i test paczki
na macOS arm64/Linux x64. Alternatywa B: rozwijać wyłącznie kod kopiowany instalatorem
do hosta; mniej zmian początkowo, trwała zależność od jego wersji i brak standalone.
A ma pełniejszy zakres dystrybucji; B nie spełnia całego celu. Walidacja: T1/T14.

### D4 [P1] (pewność 8/10) — plan modelu wymaga egzekwowanego kontraktu

GRAPH-DECISION.md:98 „Plan koordynatora jest danymi: `steps`, `capabilityId`,
`inputRefs`, `dependsOn`”. Nie określono reguł scalania wyników ani granicy plan/framework.
Rekomendacja A: stały LangGraph, rejestr umiejętności i walidator typów/zależności/
odbioru, mapy wyników po identyfikatorach. Alternatywa B: generowanie struktury
wykonywalnego grafu przez model; elastyczniejsze, większy obszar walidacji i migracji.
To wybór rodzaju, bez sztucznej punktacji. Walidacja: T4/T5 oraz grupy G03/G04/G07.

### D5 [P1] (pewność 9/10) — trwały stan i uruchamianie po restarcie

GRAPH-DECISION.md:157 „Trwały backend checkpointów” pozostaje bez wyboru;
`api/omniwatch/produce/route.ts:13` ustawia `maxDuration = 1800`, a handler
bezpośrednio wywołuje produkcję. Nie twierdzimy, że timeout już wystąpił.
Rekomendacja A: SQLite i oficjalny checkpointer, kolejka komend, pojedynczy worker
na host oraz recovery. B: PostgreSQL i serwis kolejkowy od początku, łatwiejsza
droga do wielu hostów, większa instalacja. Lokalny POC uzasadnia A. Walidacja: G04–G06/G14.

### D6 [P1] (pewność 9/10) — akceptacja rewizji i spóźnione wyniki

GRAPH-DECISION.md:93 „Zapisany, zgodny format [...] zachowuje akceptację swojej rewizji”.
`omniwatchTemplate.ts:278–280` wyprowadza ID z nazwy i wykonuje `writeFile(file, ...)`.
To nie zapewnia historii zaakceptowanych wersji. Rekomendacja A: niezmienne rewizje,
komendy z expectedRevision, deduplikacja i 409 dla starej akceptacji; stare wyniki
nie aktualizują nowego odcinka. B: nadpisywać bieżący dokument i blokować UI na czas
pracy; prostsze, nie obsłuży dwóch kart/restartu. A wymagane dla celu. Walidacja: G01/G05/G12.

### D7 [P1] (pewność 8/10) — checkpoint nie rozstrzyga przyjęcia zlecenia

GRAPH-DECISION.md:167 „Rejestr kosztowych operacji” nie opisuje stanów i rezerwacji.
Rekomendacja A: osobne submit/status/collect, operationKey, stan unknown, rozliczenie
rezerwacji i kontrola anulowania. B: polegać wyłącznie na retry/checkpointerze;
mniej kodu, brak rozstrzygnięcia awarii między API a zapisem ID. A jest potrzebne
dla poprawności kosztowej. Walidacja: G06/G11, atrapą oraz próbką konkretnego adaptera.

### D8 [P1] (pewność 8/10) — dostęp do planu, plików i narzędzi

GRAPH-DECISION.md:157 wymaga „autoryzacji akceptacji”, ale nie opisuje jej kontraktu.
Rekomendacja A: sesja lokalna, Origin/CSRF, kontrola projektu/rewizji, chroniony
adapter providerów i ograniczony dostęp do URL/plików. B: zaufać samemu loopback;
nie wystarcza wobec strony wywołującej lokalny endpoint. To luka planu, nie
udowodniony exploit istniejącego hosta. Walidacja: G13/G15/G18.

## 2. Code Quality — 2 ustalenia

### D2 [P1] (pewność 9/10) — jeden kontrakt, pełne wypełnienie

EVAL-PLAN.md:61 „To szkic grup, nie gotowy JSON Schema”.
`omniwatchEpisode.ts:188` przy brakującej wartości robi `return it`, zaś :194
zwraca `ok: true`; `slotsOf` obejmuje wszystkie tracki. Stare zachowanie nie
zapewnia kompletnej nowej treści ani ochrony `fixed` w nowym przepływie.
Rekomendacja A: wspólny schema/validator, adaptery importu i obowiązkowe nowe sloty;
przykłady tylko w preview. B: utrzymywać ręczne typy i luźną walidację w każdej
ścieżce; szybsze lokalnie, ryzyko rozjazdu. Walidacja: G01/G02/G09.

### D3 [P1] (pewność 9/10) — czas referencji i czas odcinka

EVAL-PLAN.md:44–46 rozdziela kotwicę zdarzenia od starej sekundy.
`omniwatchEpisode.ts:127–128`: „the number of slots and every slot's timing stay
exactly as given”. `omniwatchTemplate.ts:218` kopiuje `start/end` przy hydratacji.
Rekomendacja A: osobna kompilacja czasu odcinka po audio, identyfikatory zdarzeń
i mapa czasu po cięciach. B: narzucać długość/sloty referencji; nie spełni swobodnego
podcastu ani Qwena. Walidacja: G02/G10, zmieniona długość i powtarzane słowa.

## 3. Tests — 2 ustalenia

### D9 [P1] (pewność 9/10) — harness może raportować niepełny sukces

EVAL-PLAN.md wymaga blokowania wyniku bez pełnej oceny. `eval-text.mjs:296–303`
filtruje wyłącznie `scored`, a exit zależy od `bad.length`; zero ocen daje 0.
`eval-generate.mjs:313–314` przekazuje `--still --mock-host --film`, bez nowej
treści. To potwierdzone ograniczenia istniejących ewaluacji, nie nowe regresje.
Rekomendacja A: nowy harness z jawnym replay/live, wymaganymi przypadkami i
prawdziwymi instrukcjami zmian. B: tylko poprawić exit code; nie wystarczy do
wyboru modeli/promptów. Walidacja: G08/G09; istniejące raporty pozostają historyczne.

### D10 [P1] (pewność 8/10) — brak zamkniętego odbioru całego przepływu

EVAL-PLAN.md:71–75 wskazuje brak pełnych etykiet; :174–177 pozostawia pomiar
nowej referencji do wykonania. Sam zestaw 13 nazw nie daje pełnego ground truth.
Rekomendacja A: manifest fixture’ów z hashami, adnotacje i wersjonowane progi,
18 grup odbioru w TEST-PLAN, jawne E4/E5 oraz instalacja paczki. B: uznać obecne
5/5 i 4/8 za bazę całego produktu; nie mierzy nowej orkiestracji ani nowych źródeł.
Walidacja: T2/T10/T12/T13. Nie podajemy procentu pokrycia przyszłego kodu.

## 4. Performance — 2 ustalenia

### D11 [P1] (pewność 8/10) — wspólny budżet wszystkich pętli

GRAPH-DECISION.md:164 mówi o limitach, lecz bez sposobu rezerwacji.
`omniwatchProduce.ts:25` ma `LANES = 5`; niezależne gałęzie mogą sumować obciążenie.
Rekomendacja A: transakcyjne rezerwacje, limity providerów i renderów, odrębne retry
transportowe i poprawki QA. B: limity tylko wewnątrz każdego agenta; nie ograniczają
kosztu projektu. Walidacja: G11 i pomiar wszystkich prób, także odrzuconych.
Po kontroli natywnej rezerwacja dotyczy maksymalnego zobowiązania, nie szacunku;
provider bez granicy nie działa automatycznie w trybie ograniczonego budżetu.

### D12 [P2] (pewność 8/10) — zgodność cache i rozmiar materiałów

GRAPH-DECISION.md:66–70 wymaga współdzielenia obserwacji. Nie opisuje wspólnego
aktywnego wywołania ani retencji. Rekomendacja A: klucz zakres/config, single-flight,
referencje do plików, strumieniowanie i limity magazynu. B: cache tylko po URL;
może mieszać pytania/prompty i nie chroni równoległych duplikatów. Walidacja: G07/G14/G16.

## Podsumowanie sekcji

- Step 0: pełny zakres funkcji, uproszczona infrastruktura zaproponowana do akceptacji.
- Architecture: 6 ustaleń; Code Quality: 2; Tests: 2; Performance: 2.
- Diagram pokrycia i 18 grup testów w TEST-PLAN; wszystkie nowe ścieżki mają plan
  obsługi błędu oraz odbioru. Implementacja/testy nie zostały wykonane w tym review.
- D1–D11 to P1 do zamknięcia przed odpowiednim odbiorem, D12 to P2.
  Nie są to 11 zaobserwowanych awarii obecnego produktu.
- NOT in scope i What already exists: TECHNICAL. Brak nowych niezależnych TODO
  proponowanych poza uzgodnionym celem; 0 wpisów do głównego TODOS.
- Lake Score: N/A, użytkownik nie zatwierdził jeszcze nowych opcji tego review.
- Równoległość: 4 tory po kontraktach, integracja i wydanie na końcu; TASKS.
- Wymagana akceptacja: jeden pakiet propozycji D1–D12; nie oznaczono jako zatwierdzone.
- Krytyczne luki bez zaplanowanej obsługi, testu i komunikatu: 0 po doprecyzowaniu
  propozycji. Nie oznacza to, że przyszłe testy zostały już zaimplementowane.
- Kontrola natywna: 3 uwagi P1 i 1 P2 doprecyzowują istniejące D5, D6/D12, D9,
  D11; nie są czterema dodatkowymi niezależnymi decyzjami architektonicznymi.

## Suppressed findings

- Nie oceniono bezpieczeństwa całego istniejącego Agent OS na podstawie braku
  pojedynczego middleware; nie zgłoszono exploita.
- Nie uznano za sprawdzone możliwości adapterów OpenShorts/HeyGen ani pełnego
  obejrzenia shorta Juliana. Wymagania prób i fixture’ów pozostają w T7/T10/T13.
- Nie interpretujemy 5/5 jako pięciu niezależnych filmów ani 4/8 jako skuteczności
  nowej generacji. Nie deklarujemy kompletnego testu z samego zapisu historycznego.

## Metoda i ograniczenia narzędzi

Zastosowano wskazany przez użytkownika skill plan-eng-review i odczyt sekcji review
lokalnej instalacji. Sposób zadawania pytań dostosowano do wcześniejszej dyspozycji Jana.
Aside niedostępny w PATH; badanie LangGraph wykonano przez web na źródłach pierwotnych.
Cache pamięci gstack odmówił zapisu EPERM; kontekst pochodzi z rozmowy, wiki i kodu.
Preambuła działała z nakładką gpt-6-astra. Pomocniczy marker nakładki też miał EPERM.
Metadane oraz artefakty zachowujemy w repo; nie obchodzimy ograniczeń sandboxa.
Końcowe wywołania review-log, decision-log i learnings-log także odmówiły zapisu
do `~/.gstack`. Pełny zapis lokalny: [review-record.json](review-record.json);
globalny dashboard gstack nie ma wyniku tego przeglądu. Zadania do agregacji:
[tasks-eng-review.jsonl](tasks-eng-review.jsonl). Dwie trwałe obserwacje zachowano
w lokalnym rekordzie: ograniczenia obecnych evali oraz rozdzielenie reuse/live eval.
Ocena innych narzędzi/frameworków poza wskazanym LangGraph nie była potrzebna do
ustalenia proponowanej ścieżki. Nie uruchomiono implementacji, renderów ani API modeli.

## Niezależna kontrola

Zewnętrzny Claude Code: jedna próba przez gstack-claude-code, dostęp `none`,
timeout 300 s. Wynik: `unavailable`, kod `authentication`, exit 1, zero tokenów.
Komunikat: `Claude Code authentication failed. Run claude interactively in this
execution context to authenticate.` Sesja: `67f719c2-e88b-4246-9a79-bb4c07b3db1d`.
Nie powstała zewnętrzna opinia. Konfiguracja reviews była enabled; zgodnie ze
skillem wykonano kontrolę zastępczą w natywnym subagencie Codex.

Subagent `studio_eng_challenge` dostał świeży kontekst i cztery dokumenty:
TECHNICAL, ENG-REVIEW, TEST-PLAN, TASKS. Pracował wyłącznie do odczytu i zakończył
kontrolę; następnie został zatrzymany. To kontrola w tym samym systemie, nie
potwierdzenie przez inny model. Poniższe uwagi odnoszą się do wersji planu sprzed
ich doprecyzowania. Numery linii służą do identyfikacji pierwotnego dowodu.

| Uwaga | Dowód i skutek | Doprecyzowanie propozycji | Odbiór |
|---|---|---|---|
| N1 P1, pewność 8/10 | TECHNICAL:128: serializacja komend nie rozdzielała sterowania od oczekiwania na generację. Cancel/revise mogły czekać na koniec wywołania. | D5: komendy obsługiwane podczas oczekiwania grafu; krótkie transakcje; kontrola anulowania i rewizji przed autoryzacją każdej operacji. ACK przyjęcia różni się od potwierdzenia skutku. | T5, G04/G12: celowo nierozstrzygnięta odpowiedź providera, skuteczne cancel/revise przed jej końcem. |
| N2 P1, pewność 9/10 | TECHNICAL:164/219: estimate plus atomowa rezerwacja nie gwarantuje górnej granicy kosztu. | D7/D11: quote rozdziela estimate i maxLiability; rezerwacja górnej granicy; bez granicy odmowa w trybie ograniczonym; oddzielna decyzja o ekspozycji dla trybu szacowanego. | T7/T11, G11: cena ponad estimate, nieznane/opóźnione rozliczenie, naruszenie granicy dostawcy, brak podwójnego przydziału budżetu. |
| N3 P1, pewność 9/10 | TECHNICAL:208/227–230: live eval i zwykły cache nie miały rozstrzygniętej relacji. Kolejny pomiar mógł zwrócić zapisaną odpowiedź. | D9/D12: każde powtórzenie live pomija cache odpowiedzi oraz single-flight między próbami; przypięte media/preprocessing można użyć ponownie. | T9, G08: N prób daje N wywołań wybranej konfiguracji mimo pełnego cache; identyfikatory w raporcie. |
| N4 P2, pewność 8/10 | TECHNICAL:156/174: operationKey zawiera rewizję, lecz brakowało osobnego klucza ponownego użycia assetów. | D6/D12: oddzielne tożsamości operacji i assetu, hashe wejść kroków, jawne użycie zgodnych ukończonych wyników; unieważnianie tylko zależnych potomków. | T6/T12, G07/G12: sam styl napisów = zero HeyGen/głosu; zmiana jednego assetu nie regeneruje niezależnych. |

Rekomendacja subagenta: doprecyzować te cztery zasady wykonania i odbioru przed
implementacją, zachowując wszystkie uzgodnione scenariusze. Główny przegląd zgadza
się z uzasadnieniami; uwagi zostały włączone do **propozycji**, zgodnie z poleceniem
Jana, aby samodzielnie przygotować decyzje do jednej akceptacji. Nie przedstawiamy
ich jako już zatwierdzonych. Nie wykonywano drugiego niezależnego przeglądu zmian.

Status końcowy: **DONE_WITH_CONCERNS**. Przegląd czterech obszarów ukończony,
12 propozycji, 14 zadań, 18 grup odbioru, 4 tory pracy. Otwarta pozostaje zbiorcza
akceptacja; brak zewnętrznej opinii i wyników przyszłej implementacji. Weryfikacja
tej pracy obejmuje spójność dokumentów, serializację zadań i brak cykli zależności.
