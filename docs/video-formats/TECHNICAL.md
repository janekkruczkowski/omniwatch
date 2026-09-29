# Studio filmowe — plan techniczny v0.1

**Aktualny status: D1–D12 i delegacja zaakceptowane 2026-09-22, limit API 25 USD.**
[Zapis akceptacji](ACCEPTANCE.md) aktualizuje historyczny status przeglądu poniżej;
nie oznacza zaliczenia testów ani akceptacji odłożonego designu.

2026-09-22. Wynik roboczy plan-eng-review dla CONCEPT, GRAPH-DECISION i EVAL-PLAN.
Rekomendacje są przygotowane do zbiorczej akceptacji zgodnie z dyspozycją Jana.
Nie stanowią zgody na implementację. Szczegóły ustaleń: [ENG-REVIEW](ENG-REVIEW.md),
odbiór: [TEST-PLAN](TEST-PLAN.md), wykonanie: [TASKS](TASKS.md).

**Priorytet po korekcie Jana:** najpierw silnik i mierzalne evale. [UX.md](UX.md)
i [przegląd designu](DESIGN-REVIEW.md) są odłożonym szkicem przepływów;
nie wyznaczają docelowego wyglądu ani nie blokują przyjęcia planu silnika.
W silniku zachowujemy role źródeł, rewizje, znaczenie akceptacji, zakres korekty
i rozliczenie pracy niezależnie od przyszłego układu ekranów.

## 0. Scope Challenge

Zachowujemy cały uzgodniony cel: istniejące przypadki Hypit, zapis formatu,
opcjonalne umiejętności koordynatora, podcast i pełny Qwen/Julian/HeyGen.
Najmniejsza spójna realizacja: jedna aplikacja lokalna, jeden pakiet silnika,
API i worker, jeden lokalny magazyn. Moduły nie stają się mikroserwisami.
Zakres przekracza 8 plików, ale wynika z kilku rzeczywistych odpowiedzialności.
Ograniczamy infrastrukturę, bez wycinania scenariuszy użytkownika.

Pierwsze kryterium sukcesu: tani i wiarygodny benchmark ekstrakcji/zapisu/podglądu.
Uruchamiamy go przez harness/CLI i zapisane artefakty; ukończenie T8 ani designu
nie jest warunkiem E0–E3. Pierwszy wynik to raport jakości, błędów i kosztu
na znanych przypadkach, wraz z JSON-em formatu i odtwarzalnym podglądem.
Pełny odbiór kończy się podcastem i filmem Qwen/Julian, a nie samą próbą LangGraph.
Własne nagranie Jana nie jest warunkiem. Sama zmiana hosta ani fotorealizm nie
zastępują pomiaru rozumienia, napisów i poprawności montażu.

## 1. Co już istnieje i co wykorzystujemy

| Część | Wykorzystanie | Wymagana adaptacja |
|---|---|---|
| Blueprint, Template, Recipe, Motion | Własny JSON, geometria, style, zachowanie | Jedna docelowa reprezentacja formatu; adaptery starszych danych |
| Measure, Cues, BoardScan, BandScan, Verify | Pomiar i kontrola referencji | Jawne zależności providerów, wynik etapu i dowody |
| Episode | Pisanie treści do slotów | Ochrona stałych pól, pełne wypełnienie, nowe czasy |
| Compose, Clone, HyperFrames | HTML/GSAP i render | Czyste wejście odcinka, izolowany katalog wyjścia, anulowanie |
| Produce, Voice, Broll, Director | Istniejące integracje | Adaptery z rejestrem operacji i konfiguracją modelu |
| Node | Kryteria i ograniczone lokalne pomiary | Raport do LangGraph; jeden właściciel ponowień |
| Evale i 3 źródła/13 opisów | Materiał porównawczy i istniejące metryki | Wiarygodny harness, stałe etykiety, osobny replay i live |

Przepisanie wszystkich instrumentów nie jest celem. Wydzielamy je do niezależnego
pakietu etapami. Nie modyfikujemy obecnego instalatora ani plików zespołu OmniWatcha
podczas niezależnej pracy; osobny adapter integracyjny pojawia się po odbiorze.

## 2. Rozmieszczenie kodu, uruchomienie i dystrybucja (D1)

Proponowany katalog `studio/`: jeden prywatny na etapie POC pakiet TypeScript/ESM,
własny package.json, lockfile, `src/{contracts,formats,media,providers,orchestration,
storage,api}`, `web/`, `test/`, `eval/`. Bez importów z Next ani `@/lib` w silniku.
Zależności hosta są przekazywane przez adaptery; repo i testy budują się bez
`~/Documents/agent-os` oraz prywatnego routera na stałym porcie.

Node 24 jako proponowany runtime POC. Wersje LangGraph, SQLite i renderera
przypinamy w lockfile przy T1; nie deklarujemy teraz sprawdzonej kompatybilności.
Pierwsze wspierane cele: macOS arm64 Jana i Linux x64. CI na obu buduje pakiet,
testuje moduł SQLite, uruchamia offline testy i render fixture'a w odizolowanym HOME.
Wynik: archiwum z JS, UI, lockfile, manifestem, instrukcją i poleceniem startu.
Test instalacji musi sprawdzić pobranie zależności natywnych/renderera i ponowne
uruchomienie. Publikacja publiczna nie jest częścią obecnej autoryzacji.

Jedno polecenie startuje lokalny serwer i osobny proces worker. Serwer tylko
przyjmuje komendy, zapisuje je i pokazuje stan; nie trzyma generacji w żądaniu HTTP.
Lokalny POC działa pod loopback. UI jest dostępne samodzielnie w przeglądarce;
Agent OS otwiera tę samą aplikację lub używa cienkiego serwerowego adaptera.

## 3. Własny kontrakt i czas (D2, D3)

Źródłem typów jest wersjonowany JSON Schema oraz walidacja w runtime; generowane
typy TS nie stanowią drugiej ręcznie utrzymywanej definicji. Nowy główny numer
wersji rozszerza istniejący Template. Blueprint zostaje wynikiem pomiaru/kompilacji,
a starszy VideoFormat ma adapter importu. Nie powstają trzy równoległe biblioteki.

| Rekord | Kluczowe pola i reguły |
|---|---|
| ArtifactRef | id, revision, sha256, kind, relativePath; plik wewnątrz magazynu projektu |
| Observation | sourceRef, span/frameRefs, methodVersion, facts, provenance, uncertainty |
| Format | schemaVersion, id, revision, canvas, regions, styles, slots, behaviors, provenance |
| Episode | formatRef, script, bindings, sourceSpans, eventAnchors, resolvedTimeline |
| ExecutionPlan | revision, steps, capabilityId, inputRefs, dependsOn, outputs, limits |
| Approval | projectId, artifactRef/planRevision, scope, decision, ownerId, createdAt |

Regiony i sloty mają unikalne ID; wszystkie odwołania muszą istnieć. Geometria jest
znormalizowana [0,1], warstwy uporządkowane, czasy skończone i nieujemne, referencje
nie wychodzą poza materiał. `fixed` chroni dane formatu; `episode` wymaga nowej
treści lub jawnie wskazanego materiału. Przykłady z referencji służą do podglądu;
w nowym odcinku brak slotu zwraca `needs_input`, nie cudzą treść jako gotowy wynik.

Format rozróżnia czas absolutny referencji i kotwice zdarzeń w odcinku. Kotwica
wskazuje stabilny ID wypowiedzi/werdyktu, nie wyszukiwanie pierwszego pasującego
słowa w całym filmie. Odcinek przechowuje mapowanie źródło → wynik po cięciach.
Najpierw planujemy segmenty i wstępną długość; po otrzymaniu audio/prezentera
mierzymy czasy słów i kompilujemy finalne napisy oraz animacje. Brak pasującej
kotwicy wraca do planera; nie wstawiamy sekundy referencji jako ukrytego fallbacku.
Przekroczenie zadanej długości daje propozycję skrócenia treści albo nowy plan,
bez domyślnego przyspieszania głosu lub obcinania zdania.

Importer starszych formatów zachowuje oryginał. Jeśli brak pola nie pozwala
odtworzyć formatu, wynik jest `needs_review` z listą braków. Akceptacji nie nadaje
migracja. Round-trip i porównanie podglądu sprawdzają recipe/ruch/napisy.

## 4. Koordynator i wykonanie planu (D4)

Stały graf LangGraph ma węzły: przyjęcie, planowanie, walidacja, wybór umiejętności,
wywołania zarejestrowanych podgrafów, zebranie wyników, kontrola/bramka i odbiór.
Model nie buduje wykonywalnego grafu ani nie generuje dowolnego kodu.
ExecutionPlan opisuje wybrane umiejętności i zależności; retry, checkpointy,
rozgałęzienia i wznowienia realizuje LangGraph. Nie implementujemy ich ponownie
w osobnym silniku planów. Lokalne pętle instrumentów mają jawny budżet nadrzędny.

Walidator planu sprawdza: znane capabilityId i wersje, typy wejść, brak cykli,
osiągalność wyników, zakres źródeł, uprawnienia, limity, wymagane QA/akceptacje.
Gotowy format pomija analizę i ponowną akceptację tej samej rewizji. Gotowe assety
pomijają generację. Brak materiału źródłowego pomija analizę materiału. Render
wymaga kompletnej kompozycji, nie koniecznie agenta montażowego.

Rozumienie referencji należy do ekstrakcji formatu. Rozumienie materiału nowego
odcinka (np. demonstracji Qwen, artykułu lub podcastu) jest osobną umiejętnością.
Nie uruchamiamy jej dla samego tematu bez materiału. Obie umiejętności mogą użyć
tych samych zgodnych obserwacji, jeśli rzeczywiście dotyczą tego samego źródła.

```text
cel + referencje do dostępnych wyników
  → koordynator [E3] → walidator planu
      ├─ niepoprawny → kontrolowana korekta / widoczny problem
      └─ poprawny → potrzebne podgrafy [E1/E3/E4]
                         → walidacja wyników → QA → bramka, jeśli wymagana
                         → kompletna kompozycja → render → QA → odbiór
```

Każdy podgraf ma osobny stan i wynik. Wspólne obserwacje używają tego samego
ArtifactRef, jeśli zakres i konfiguracja pasują. Wyniki równoległe są mapą po
`stepId + revision + attemptId`; reducer łączy rozłączne klucze, identyczny powtórny
wynik jest idempotentny, konflikt pod tym samym kluczem blokuje zatwierdzenie.
Nie łączymy historii wszystkich agentów w jeden rosnący prompt.

## 5. Trwałość, rewizje i bramki (D5, D6)

POC: lokalny SQLite z oficjalnym checkpointerem LangGraph JS; własne tabele
projects, commands, revisions, approvals, operations, artifacts i reservations.
DB poza synchronizowanym Vaultem. Jeden worker odpowiada za stan wykonania;
API dopisuje komendy do kolejki. Krótkie mutacje stanu są serializowane per projekt.
Drugi start workera na tej samej bazie jest odrzucany przez blokadę procesową.
T1/T5 muszą wykazać blokadę między procesami, timeouty zapisu i recovery.
To profil jednego hosta; uruchamianie wielu serwerów jest poza tym POC.

Komenda create/approve/revise/cancel ma commandId oraz oczekiwaną rewizję.
Identyczna powtórka zwraca poprzedni rezultat; stara rewizja daje 409 i aktualny
podgląd. Mutacja komendy i rewizji jest transakcyjna. Worker budzi się po trwałym
zapisie, a po restarcie odczytuje nieobsłużone komendy i checkpointy.

Obsługa komend działa także wtedy, gdy graf czeka na generację lub render.
Nie trzyma blokady projektu ani transakcji podczas oczekiwania na zewnętrzne API.
`cancel`/`revise` zapisuje skutek i potwierdza go przed zakończeniem aktywnego
wywołania; samo HTTP 202 potwierdza tylko przyjęcie komendy. Rozpoczęcie każdej
kosztowej operacji wymaga transakcyjnego sprawdzenia bieżącej rewizji, anulowania
i rezerwacji. Po skutecznym anulowaniu nie autoryzujemy nowych operacji.
Już autoryzowane wywołania dostają sygnał przerwania, o ile adapter to wspiera;
wyścig z dostawcą rozliczamy jako operację w toku lub `unknown`, nie jako brak kosztu.
Korekta tworzy nowy plan; spóźnione wyniki starego nie mutują jego stanu. Nie
wznawiamy równolegle tego samego wykonania LangGraph przez komendę sterującą.

```text
queued → running → awaiting_approval → running → completed
             ├─ budget / missing_input / unknown_operation → needs_attention
             ├─ permanent_error → failed
             └─ cancel → cancelling → cancelled
```

Pliki zapisujemy temp → hash/rozmiar → atomowa publikacja na tym samym filesystemie
→ rejestracja w DB. Rekord wyniku wskazuje dopiero kompletny plik. Awaria może
zostawić osierocony plik, nigdy zaakceptowany rekord wskazujący niepełny wynik.
Po restarcie sprawdzamy spójność; sprzątanie omija pliki aktywnych projektów.

Checkpointer i tabele aplikacji nie dają jednej transakcji z zewnętrznym API.
Przed wykonaniem węzeł odczytuje operations; ukończony wynik zwraca przez ArtifactRef,
także jeśli checkpoint nie zdążył się zapisać. Błąd zapisu stanu zatrzymuje nowe
kosztowe operacje. W próbie używamy zapisu checkpointów przed przejściem dalej
(`sync`, jeśli wspierane przez przypiętą wersję); test awarii weryfikuje faktyczne zachowanie.

Rewizje formatu i odcinka są niezmienne. Korekta tworzy nową; unieważniamy wyniki
i akceptacje zależne od zmienionych wejść. Plan zapisuje zależności i hashe wejść
oraz konfiguracji każdego kroku. Niezmienny, ukończony asset można jawnie przypisać
do nowego planu, jeśli jego wejścia, konfiguracja i zakres dostępu nadal pasują.
To referencja do istniejącego wyniku, nie ponowne wykonanie operacji starej rewizji.
Wynik, który dopiero nadejdzie ze starego zadania, zapisujemy historycznie; sam
nie trafia do bieżącej kompozycji. Ewentualne użycie wymaga nowej walidacji zgodności.
Zmiana wyglądu napisów zachowuje głos/prezentera, lecz unieważnia render i jego QA.
Zmiana tekstu wypowiedzi może wymagać nowego audio i wszystkich zależnych czasów.
Manifest grafu/modeli
jest przypięty do uruchomienia; aktualizacja aplikacji odmawia wznowienia zadania
na niezgodnej wersji i wskazuje poprzedni pakiet lub jawną migrację.

## 6. Adaptery i operacje kosztowe (D7)

Interfejs dostawcy obejmuje capabilities, quote, submit, status, collect oraz
cancel, jeśli wspierane. Manifest opisuje, które metody są dostępne. Brak możliwości
sprawdzenia submit po timeout jest jawnym ograniczeniem adaptera, nie powodem retry.
Sekrety dostaje adapter z konfiguracji hosta; nie zapisujemy ich w planie/promptach.
`quote` rozdziela szacunek (`estimate`) od maksymalnego zobowiązania
(`maxLiability`, waluta, wersja cennika i ograniczenia żądania). Nie każdy adapter
potrafi podać górną granicę; brak tej zdolności pozostaje jawny.

```text
planned → reserved → submitting → submitted(providerJobId) → succeeded / failed
                          └─ brak pewności → unknown → reconciliation / decyzja
```

operationKey wiąże projekt, rewizję, krok, hash wejść i konfigurację. Ten sam klucz
nie tworzy drugiego aktywnego submit. Idempotency key dostawcy stosujemy, gdy
rzeczywiście go wspiera. Bez niego awaria po przyjęciu żądania, przed zapisem ID,
daje `unknown`. Rezerwacja kosztu pozostaje zajęta do rozstrzygnięcia.
Osobny artifactReuseKey opiera się na faktycznych wejściach i konfiguracji kroku,
bez numeru rewizji planu. Służy do walidowanego ponownego użycia ukończonych assetów
w ramach dozwolonego projektu, nigdy do utożsamienia dwóch zleceń kosztowych.
Anulowanie zatrzymuje nowe zlecenia; rozpoczęte zadanie może nadal naliczyć koszt,
jeśli dostawca nie wspiera cancel. UI pokazuje ten stan i późniejszy wynik jako nieaktywny.

Modele, prompty, narzędzia i preprocessing mają osobne wersje, zamrożone w jednym
manifeście. Nowy model przechodzi eval odpowiedniego etapu i zależnych wyników.
Koordynator może dobierać tylko zatwierdzone konfiguracje; nie wprowadza sam nowego
modelu do produkcji. Fallback to osobna konfiguracja z wynikiem evala.

OpenShorts/video-use: adapter do konkretnych operacji, nie drugi nadrzędny agent.
Przed włączeniem T7 utrwala repo/commit, wymagania wykonania i dostępne wejścia/
wyjścia; sprawdza zdolność zwrócenia cięć/kadrów z mapą czasu. Jeśli narzędzie nie
udostępnia potrzebnej granicy, integracja nie jest uznana za gotową; wynik próby
wraca do decyzji adaptera. Nie zakładamy, że instrukcje dla Claude Code to gotowe API.

## 7. Granice dostępu i danych (D8)

W lokalnym POC API akceptuje tylko lokalną sesję: token w bezpiecznej sesji hosta,
kontrola Origin/CSRF dla mutacji, żadnych kluczy providerów w JS przeglądarki.
Adapter Agent OS uwierzytelnia się serwerowo. Autoryzacja dotyczy projektu i
konkretnej rewizji; znajomość ID pliku/checkpointu nie daje dostępu.

Link/artykuł/napisy są materiałem do analizy, nigdy poleceniem zmiany planu lub
wywołania narzędzia. Pobieranie działa w jednym adapterze z limitem rozmiaru/czasu,
kontrolą adresów prywatnych oraz przekierowań. Ścieżki uploadów rozwiązywane są
do katalogu projektu z kontrolą symlinków. Narzędzia uruchamiane przez argv,
bez wstawiania treści w shell. Generowany podgląd korzysta z naszego renderera,
izolowanego kontekstu i jawnych assetów, bez dowolnego JS/HTML od modelu.

## 8. Evale, wydajność i koszty (D9–D12)

E0–E5 zachowują definicje EVAL-PLAN. E0 i testy mają blokadę sieci/providerów;
E1/E3 są jawnymi eksperymentami z nową konfiguracją, nie replayem starego modelu.
Manifest zawiera tryb i identyfikator każdej próby. W trybie live każda oceniana
próba pomija cache odpowiedzi modeli i współdzielenie wywołań między próbami;
musi wywołać wybraną konfigurację i zapisać identyfikator wywołania. Można użyć
cache niezmiennego pobrania/przetwarzania mediów. Replay używa przypiętych
odpowiedzi z blokadą sieci. Brak dowodu wywołania modelu w live oznacza brak oceny,
nie kolejny udany pomiar. Ta reguła dotyczy także powtórzeń tej samej konfiguracji.
Każdy wymagany błąd lub nieoceniony przypadek blokuje sukces. Wzorzec i progi są
przypięte przed startem. Raport przechowuje metryki per źródło, licznik wariantów,
koszt z QA/retry, latencję i unknown costs. Przy E3 oceniamy też zbędne operacje.

Brakujące anotacje geometrii/zdarzeń wymagają dowodów i przeglądu w T10. Do tego
czasu metryka pozostaje `not_ready`; nie przyjmujemy arbitralnego progu jako dowodu.
Przy podmianach porównujemy wymaganą zmianę oraz chronione własności, nie tekst
przypadku generate z tekstem filmu extract. Nowa transkrypcja po zmianie audio.

Przy starcie eksperymentu operator podaje limit kosztu; brak ceny nie jest zerem.
W trybie ograniczonego budżetu rezerwujemy maksymalne zobowiązanie, nie średni
szacunek. Górna granica wynika z przypiętego cennika i egzekwowanych limitów
żądania (np. tokeny wyjściowe, długość, liczba wariantów). Adapter bez takiej
granicy nie może uruchamiać się automatycznie w tym trybie. Tryb z kosztem jedynie
szacowanym wymaga osobnej zapisanej decyzji operatora o ekspozycji; UI nie nazywa
go twardym limitem. Nie zakładamy dziś, że każdy wybrany provider ma tę zdolność.
Rezerwacje są transakcyjne i wspólne dla gałęzi, retry oraz korekt. Rozliczenie
następuje po uzyskaniu rzeczywistego kosztu; nieznany koszt zatrzymuje rezerwację.
Koszt powyżej szacunku, lecz w granicy zobowiązania, rozliczamy normalnie.
Naruszenie zadeklarowanej granicy przez dostawcę wstrzymuje nowe operacje i jest
widocznym przekroczeniem; rejestr lokalny nie cofa już wystawionego rachunku.
Proponowane limity początkowe: 2 równoległe zlecenia per provider, 1 render
CPU na worker; zmieniane konfiguracją po pomiarach. Pętle jakości max 2 poprawki
po pierwszej próbie; globalny limit 20 zleceń poprawkowych na projekt oraz budżet
mają pierwszeństwo. Liczby to ustawienia startowe do evala, nie zmierzone optimum.

Cache: sourceHash + zakres + preprocessing + capability/model/prompt/tool versions.
Single-flight rejestruje aktywne obliczenie po tym kluczu; drugi konsument czeka na
wynik, nie uruchamia kopii. Błędny/niepełny wynik nie jest cache hit. Różne pytania
do filmu współdzielą tylko zgodne obserwacje, nie dowolną odpowiedź modelu.
Wyjątek: opisany wyżej live eval wyłącza cache odpowiedzi i single-flight między
niezależnymi próbami. Korekta planu stosuje artifactReuseKey oraz zależności D6;
zmiana jednego assetu unieważnia jego potomków, nie niezależne assety odcinka.
Źródła są strumieniowane, klatki próbkowane według manifestu; długie materiały
dzielone z zachowaniem globalnych czasów i kontekstu na granicach.

Domyślny limit cache roboczego 10 GB, sprzątanie zakończonych plików tymczasowych
po 7 dniach; zaakceptowane formaty/wyniki i przypięte fixture’y nie są usuwane.
Brak miejsca wstrzymuje generację z informacją do użytkownika. Telemetria lokalna
obejmuje project/run/step/config IDs, czas, koszt, cache hit, próby, powód pominięcia
i wynik QA. Treści i klucze są pomijane w zwykłych logach. LangSmith nie jest
warunkiem lokalnego POC; nie dodajemy płatnej platformy do obowiązkowych zależności.

## 9. NOT in scope

- Wieloużytkownikowy płatny cloud, billing i autoscaling: po lokalnym odbiorze;
  wymagają osobnego planu tenantów, sekretów, storage i deploymentu.
- Windows i macOS x64 w pierwszej macierzy: pierwszy POC jest dla Jana; rozszerzenie
  platform wymaga testów pakietu/SQLite/renderera, nie samej deklaracji wsparcia.
- Publiczne wydanie, instalacja do żywego Agent OS i masowe płatne evale: nie są
  działaniami obecnego przeglądu. Przygotowanie paczki i test instalacji pozostają w planie.
- Własny framework grafu, edytor dowolnego kodu filmowego i przebudowa OmniWatcha:
  nie są potrzebne do uzgodnionych scenariuszy.

## 10. Źródła techniczne i ograniczenia weryfikacji

LangGraph: [podgrafy](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs),
[checkpointy](https://docs.langchain.com/oss/javascript/langgraph/checkpointers),
[wznowienia](https://docs.langchain.com/oss/javascript/langgraph/interrupts),
[reduktory przy równoległości](https://docs.langchain.com/oss/javascript/langgraph/errors/INVALID_CONCURRENT_GRAPH_UPDATE),
[adapter SQLite JS](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-sqlite).
Dokumentacja potwierdza istnienie mechanizmów. Ich dopasowanie do naszego runtime
i odporność na awarie mają zostać wykazane przez T1/T5; nie były uruchamiane w tym review.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| CEO | plan-ceo-review | Cel i zakres | 1 rozpoczęty | Nieukończony | CEO-REVIEW, brak pełnego werdyktu |
| Eng | plan-eng-review | Architektura, kod, testy, koszty | 1 | Zakończony przegląd, issues_open (PLAN) | 12 rekomendacji D1–D12 do zbiorczej akceptacji |
| Outside | Claude Code | Niezależna opinia zewnętrzna | 1 próba | unavailable: authentication | Brak wyniku i pokrycia zewnętrznego |
| Native challenge | Subagent Codex, zastępstwo po awarii | Kontrola wykonalności | 1 | Zakończony | 4 doprecyzowania włączone do propozycji: D5, D6/D12, D9, D11 |
| Design | design-review → plan-design-review | UI akceptacji i korekt | 1 | deferred_by_user | Roboczy prototyp; bez akceptacji wyglądu i bez blokowania silnika |
| Outside design | Claude Code / native | Kontrola UX | 1 próba / 1 natywna | External unavailable, native completed | Auth failure; 5 uwag natywnych w propozycji UX |
| DX | plan-devex-review | Instalacja i integracja | 0 | Nie wykonano | W tym review plan G18, bez osobnego przeglądu DX |

**OUTSIDE COVERAGE:** Claude Code, plan-review, unavailable; błąd uwierzytelnienia.
Kontrola natywna nie zastępuje opinii innego systemu. Szczegóły: [ENG-REVIEW](ENG-REVIEW.md).

**VERDICT:** DONE_WITH_CONCERNS — przegląd ukończony; propozycja jest gotowa do
zbiorczej akceptacji, nie ma jeszcze statusu ENG CLEAR. Brak walidacji implementacji
i zewnętrznej opinii. eng review required: akceptacja poniższego pakietu.

**UNRESOLVED DECISIONS:**
- Zbiorcza akceptacja D1–D12 z czterema doprecyzowaniami kontroli natywnej oraz proponowanej granicy lokalnego POC.
