# Orkiestracja i zależności — rekomendacja LangGraph

2026-09-22. Rekomendacja do planu technicznego po pytaniu Jana. Bez instalacji,
migracji ani deklaracji ukończonego plan-eng-review. Dotyczy studia filmowego;
nie zmienia autonomicznie realizowanego planu OmniWatcha.

## 1. Dlaczego ponownie rozpatrujemy decyzję

[GRAPH-PLAN §4](../../agent-os-module/docs/GRAPH-PLAN.md) odraczał framework dla
11 kroków sekwencji. Wskazywał powrót do LangGraph przy gałęzi długi film → shorty,
równoległości i checkpointach. Obecny zakres spełnia te warunki, a dodatkowo
zawiera osobne pętle QA, akceptacje i korekty części projektu.

`omniwatchNode.ts` zapewnia lokalne `run/accepts/retry/onGiveUp` i raport prób.
Nie jest pełnym silnikiem trwałego wykonania projektu. Utrzymujemy użyteczne
funkcje pomiarowe i walidatory; nie rozbudowujemy tej pętli w drugi framework.

**Rekomendacja: LangGraph JS/TS jako biblioteka orkiestrująca istniejące narzędzia.**
LangGraph obsługuje mieszanie kroków deterministycznych i agentowych; używanie
abstrakcji modeli LangChain nie jest wymagane. Nie utożsamiamy jednak tego z brakiem
zależności pakietowych: dokumentacja instalacji obejmuje także `@langchain/core`.
[Źródło: overview](https://docs.langchain.com/oss/javascript/langgraph/overview).

Koszt wyboru: utrzymanie zależności, poznanie semantyki wznowień i zapisu stanu,
wersjonowanie grafów. Alternatywa własna oznacza samodzielną implementację tych
mechanizmów. Przy opisanym zakresie przewaga oszczędności na zależności jest mniejsza
niż koszt utrzymywania własnego silnika. To ocena architektoniczna, nie wynik benchmarku.

## 2. Trzy rodzaje zależności

1. **Praca:** krok czeka na wynik innego kroku, może uruchomić podgraf, poprawkę
   albo bramkę użytkownika. Za przejścia i checkpointy odpowiada LangGraph.
2. **Dane:** format, obserwacje, plan odcinka, assety i render wskazują rewizje
   swoich wejść. Nasza aplikacja decyduje, co unieważnić po zmianie.
3. **Konfiguracja wykonawcy:** konkretny etap wskazuje model, prompt, adapter
   i wersję narzędzi. Evale dopuszczają nowe konfiguracje do użycia.

Framework nie wybiera automatycznie lepszego modelu i nie zna znaczenia naszych
formatów ani reguł jakości. Zmiana zależności pakietowej także jest osobną zmianą
do przetestowania, nie aktualizacją przez pływającą wersję w działającym zadaniu.

## 3. Koordynator dobiera potrzebne umiejętności

Korekta Jana: podgrafy są opcjonalnymi umiejętnościami, a ich zależności wynikają
z zadania i dostępnych wyników. Nie każdy projekt uruchamia analizę formatu,
analizę materiału i montaż. Koordynator korzysta z modelu o mocnym rozumowaniu,
żeby rozpoznać intencję, ułożyć plan i dostosować go do wyników oraz poprawek.

Rozróżniamy:

- **Rozpoznanie formatu:** zrozumienie, co dzieje się w referencji i jak to jest
  przedstawione, następnie pomiar i zapis reguł. Semantyka jest częścią tej pracy:
  ruch ikony wynika np. z ogłoszenia werdyktu. To nie jest sama geometria.
- **Analiza materiału odcinka:** zrozumienie prezentacji Qwena, artykułu, podcastu,
  audio lub nagrania, z którego ma powstać nowy przekaz. Potrzebna tylko wtedy,
  gdy zadanie wymaga wykorzystania takiego źródła i nie ma wystarczającej analizy.
- **Tworzenie scenariusza:** opracowanie własnej treści według tematu/briefu albo
  dostarczonych źródeł. Brak źródłowego filmu nie blokuje tego etapu i nie uruchamia
  sam z siebie analizy mediów. Gotowy scenariusz wymaga tylko stosownego dopasowania.
- **Uzupełnienie szablonu:** przypisanie scenariusza, prezentera i assetów do slotów,
  wyliczenie czasów i kompozycja według formatu. Nie wymaga wyboru fragmentów
  ani osobnego agenta montażowego, jeśli wszystkie potrzebne decyzje są już określone.
- **Montaż materiału:** wybór i cięcie fragmentów, kadrowanie oraz przebudowa
  sekwencji. Uruchamiany, kiedy źródła i cel wymagają tych operacji.

Oba rodzaje analizy korzystają ze wspólnych narzędzi oglądania, ASR i pomiarów.
Jeśli referencja jest zarazem materiałem odcinka, dzielą zgodne obserwacje i cache.
Role pozostają oddzielne; nie analizujemy dwa razy identycznego zakresu tylko
dlatego, że potrzebują go dwa podgrafy. Równoległość jest możliwa dopiero po
uwzględnieniu tych współdzielonych zależności.

```text
cel + formaty + materiały + dotychczasowe wyniki
                        ↓
             koordynator → plan → walidacja zależności
                        ↓ dobór potrzebnych umiejętności
 format:     użyj zapisanego LUB rozpoznaj nowy → podgląd/QA/akceptacja
 treść:      użyj gotowej LUB napisz scenariusz [analiza źródeł, jeśli potrzebna]
 produkcja:  uzupełnij sloty [generuj brakujące elementy] [montuj źródła]
                        ↓
             kompozycja → render → QA → odbiór
                                    ↘ problem do właściwej umiejętności
```

| Wejście | Minimalny plan |
|---|---|
| Zatwierdzona tier lista + temat | Wczytanie formatu, scenariusz, prezenter/assety, sloty, render i QA |
| Zatwierdzony format + gotowy scenariusz i komplet assetów | Dopasowanie treści/czasów, sloty, render i QA |
| Zatwierdzony format + długi podcast | Analiza podcastu, wybór fragmentu/osób, montaż, napisy, render i QA |
| Nowy short Juliana + prezentacja Qwena | Rozpoznanie formatu Juliana, analiza Qwena, scenariusz, cięcia/HeyGen/napisy, render i QA |
| Zatwierdzony format Juliana + przeanalizowany Qwen | Użycie obu zapisanych wyników, przygotowanie odcinka i produkcja |

Zapisany, zgodny format wskazany przez użytkownika zachowuje akceptację swojej
rewizji. Nie wymuszamy ponownego odczytu referencji, podglądu placeholderów ani
zatwierdzania tego samego formatu przy każdym odcinku. Nowy format lub jego zmiana
przechodzą odpowiednią bramkę. Odcinek ma własne QA i odbiór.

Plan koordynatora jest danymi: `steps`, `capabilityId`, `inputRefs`, `dependsOn`,
`expectedOutputs`, limity i warunki odbioru. Wybiera ze zdefiniowanych umiejętności;
nie generuje dowolnego kodu sterującego. Każda umiejętność deklaruje wejścia,
wyniki i warunki użycia, więc walidator może wykryć brak zależności przed wykonaniem.
Koordynator może zmienić plan na podstawie nowych dowodów, zachowując historię
rewizji i dotychczasowe zgodne wyniki. Wiązania modeli/promptów zostają w ramach
zamrożonego manifestu; poszerzenie budżetu lub zakresu akceptacji wymaga nowej decyzji.

Gotowe strategie ograniczają koszt planowania powtarzalnych zadań. Mocniejszy model
jest potrzebny do wyboru lub zmiany strategii; walidacja plików, wyliczenie czasu
czy każdy krok renderera nie wymagają ponownego rozumowania koordynatora.

Każdy podgraf ma własne wejścia, wynik i limity. Może samodzielnie zbierać
dodatkowe dowody i korygować pracę, ale zwraca ustalony kontrakt. Subgraf nie musi
być jednym agentem: obejmuje modele, zwykłe funkcje i narzędzia. Koordynator
nie otrzymuje całej historii każdego wykonawcy; dostaje wynik, dowody i stan QA.

LangGraph pozwala zagnieżdżać grafy i przekazywać między nimi dane. Trwałość
podgrafów trzeba konfigurować świadomie; równoległe wywołania nie mogą dzielić
przypadkowo tej samej przestrzeni checkpointów. Proponujemy stan na wywołanie
dla izolowanych analiz i jawnie oddzielone identyfikatory zadań produkcji.
[Źródło: subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs).

## 4. Model i prompt są wymienne na poziomie etapu

Konfiguracja uruchomienia wskazuje `graphVersion`, wersję kontraktów i manifest
etapów: `stageId`, `modelId`, `promptHash`, `adapterVersion`, `toolVersions`,
parametry, limit kosztu/prób i identyfikator oceny dopuszczającej konfigurację.
Cały manifest zamrażamy na początku zadania. Zmiana modelu tworzy nowy eksperyment
lub rewizję pracy, nie podmienia po cichu wykonawcy w połowie projektu.

Adapter deklaruje rzeczywiste możliwości: obraz, wideo, audio, rozdzielczość,
próbkowanie, limit kontekstu, format wyniku i sposób obsługi narzędzi.
Nie zakładamy, że każdy model obsługuje te same wejścia. Inna strategia dzielenia
filmu lub dodatkowy ASR jest częścią wersjonowanej konfiguracji analizy.
Niezgodny wykonawca daje jawny błąd doboru; fallback jest osobną, ocenioną konfiguracją.

Nasz JSON pozostaje kontraktem niezależnym od odpowiedzi konkretnego dostawcy.
Model może wyprodukować wynik do normalizacji; walidator i QA rozstrzygają,
czy można go wykorzystać. LangGraph state zawiera identyfikatory, rewizje,
referencje do plików, decyzje i raporty, nie kopie MP4 ani wszystkie klatki.

## 5. Zmiana konfiguracji i zależne evale

| Zmiana | Bezpośredni eval | Sprawdzenie zależności |
|---|---|---|
| Model/prompt analizy formatu | E1 na ustalonych źródłach, koszt i rozrzut | E0 zapis/odczyt i E2 podgląd otrzymanego formatu |
| Rozumienie treści bez audio | E1 na zdarzeniach z dowodami | Plan/scenariusz i powiązanie ujęć; E5 dla kandydata do wydania |
| Planer lub prompt zmian | E3 na zamrożonych poprawnych wejściach | E4/E5 dla zmienionych strategii |
| Generator lub jego prompt | Ocena adaptera i konkretnego slotu | Synchronizacja i wybrane rendery; bez bezcelowego powtarzania ekstrakcji |
| Renderer | E0 i E2 na stałych JSON-ach | Odbiór odpowiednich E4/E5 |
| Graf, retry lub checkpointy | Awarie, wznowienia, izolacja stanu, limity | Podgrafy i scenariusz integracyjny z atrapami dostawców |

Numery E0–E5 odsyłają do [EVAL-PLAN](EVAL-PLAN.md). Ocena etapu izoluje przyczynę
zmiany; ocena dalszej części procesu wykrywa, czy pozornie lepszy wynik nie zepsuł
montażu. Obie są potrzebne. Raport ocenia koszt całej pętli, w tym odrzuconych prób.

## 6. Co pozostaje odpowiedzialnością aplikacji

- Trwały backend checkpointów, obsługa projektów i autoryzacja akceptacji.
  `MemorySaver` nie przeżywa restartu; wybór konkretnego trwałego backendu oraz
  migracji musi wejść do planu wdrożenia.
  [Źródło: persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence).
- Osobny worker wykonuje długą pracę, a UI uruchamia, obserwuje i wznawia projekt.
  Samo zapisanie checkpointu nie uruchamia procesu po awarii. Pliki multimedialne
  mają osobny magazyn z cyklem życia; nie są biblioteką wiedzy OmniWatcha.
- Limity globalne i per podgraf, anulowanie oraz kontrola równoległości providerów.
  Retry sieciowe i poprawka merytoryczna mają odrębne budżety. Nie mnożymy bez
  kontroli ponowień SDK × lokalna pętla × graf nadrzędny.
- Rejestr kosztowych operacji: identyfikator operacji, żądania i zadania dostawcy,
  status, wynik. Po niepewnej odpowiedzi sprawdzamy istniejące zadanie. Jeśli nie
  można rozstrzygnąć wyniku, nie zlecamy automatycznie kolejnej generacji.

W LangGraph wznowienie po `interrupt` wykonuje węzeł od początku. Dlatego bramka
akceptacji jest osobnym węzłem, a kosztowe zlecenie osobną operacją. Rozdzielenie
zmniejsza ryzyko, lecz nadal wymaga obsługi awarii między zleceniem u dostawcy
a zapisaniem jego ID. Framework nie gwarantuje pojedynczego rozliczenia zewnętrznego API.
[Źródło: interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts).

LangGraph checkpoint nie zastępuje trwałego formatu produktu. Nadal potrzebujemy
eksportowalnego JSON-a oraz reguł unieważniania wyników i akceptacji. Nie wdrażamy
zmiany nazwy/usunięcia węzła pod zawieszone zadanie bez procedury migracji lub
dostępnego starego wykonawcy. Dokumentacja opisuje ograniczenia takich zmian.
[Źródło: graph migrations](https://docs.langchain.com/oss/javascript/langgraph/graph-api#graph-migrations).

## 7. Wąska próba techniczna przed szeroką migracją

Po akceptacji kierunku przygotować izolowaną próbę na zapisanych danych evali:
istniejący pomiar/format → atrapa recenzenta → poprawa → podgląd → akceptacja.
Bez płatnych generacji i przepisywania całego produktu. Kryteria:

1. Restart przed i po bramce zachowuje wynik oraz właściwą wersję akceptacji.
2. Restart po przyjęciu zadania przez atrapę providera nie zleca go drugi raz.
3. Dwie równoległe analizy nie mieszają wyników ani historii recenzenta.
4. Nieudane QA wraca tylko do wskazanego etapu i kończy się po limicie.
5. Zmiana prompta daje osobny eksperyment; stare zadanie zachowuje swój manifest.
6. Korekta napisu odtwarza kompozycję bez ponownego generowania prezentera.
7. Można osobno uruchomić i ocenić podgraf analizy bez grafu produkcyjnego.
8. Zapisany format i temat pomijają analizę referencji oraz nieistniejących źródeł.
9. Kompletne sloty pomijają generowanie i wybór fragmentów; render i QA nadal działają.
10. Wspólne źródło obu analiz nie powoduje podwójnego opłacenia tej samej obserwacji.

To próba dopasowania frameworka i integracji. Nie zastępuje E1 sprawdzającego
rzeczywiste ograniczenia modeli ani pełnego filmu Qwen/Julian.
