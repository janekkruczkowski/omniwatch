# Studio tworzenia filmów — cel i dekompozycja

2026-09-22. Doprecyzowanie po wypowiedzi Jana. Nazwa robocza.
Wymagania poniżej pochodzą z rozmowy; architektura i kolejność to propozycja
do wspólnego przeglądu. Dokument nie oznacza rozpoczęcia implementacji ani
ukończonego przeglądu CEO. Przegląd inżynierski zakończył się propozycją
[TECHNICAL.md](TECHNICAL.md), która czeka na zbiorczą akceptację.
Roboczy szkic przepływów: [UX.md](UX.md). Jan odłożył design do czasu sprawdzenia
silnika; szkic nie określa docelowego wyglądu i nie blokuje planu technicznego.

**Aktualizacja użytkownika:** pierwszy odbiór opieramy na istniejących przypadkach
Hypit i evalach, nie na własnym nagraniu Jana. Następnie podcast z rzeczywistego
materiału i pełna integracja Qwen + format shorta Juliana + HeyGen + napisy.
Szczegółowy plan pomiarów i kontraktu: [EVAL-PLAN.md](EVAL-PLAN.md).

Warstwa techniczna zależności i propozycja ponownego wyboru silnika grafu:
[GRAPH-DECISION.md](GRAPH-DECISION.md). Rekomendacja: LangGraph JS/TS do orkiestracji,
z własnymi kontraktami danych i oddzielnymi adapterami modeli; do akceptacji.

## 1. Cel i granice produktu

Użytkownik przekazuje zamiar, linki, materiał lub scenariusz. Wbudowany agent
przygotowuje film: rozumie materiał, wybiera fragmenty, montuje, generuje potrzebne
uzupełnienia i stosuje format. Użytkownik może kierować pracą rozmową i akceptuje
ważne wyniki. Nie musi podpinać własnego agenta kodującego ani MCP.

Astros jest opcjonalnym źródłem gotowego researchu. Wejście bezpośrednie przez link,
własne pliki lub scenariusz jest równorzędne. Docelowe powierzchnie: Agent OS
oraz aplikacja przeglądarkowa standalone; szczegóły ich dystrybucji wymagają planu.

Punktem odniesienia użytkownika jest funkcjonalność odtwarzania formatu znana mu
z Hypit, rozwinięta o własny materiał, montaż i generowanie w jednym procesie.
Nie zakładamy, że opis użytkownika stanowi pełny audyt możliwości konkurencji.
Implementacja ma respektować licencje; bezpośrednie wykorzystanie video-use lub
OpenShorts wymaga sprawdzenia konkretnego repozytorium, wersji i zależności.
Nie przesądzamy teraz o użyciu ich kodu ani o licencji na podstawie nazwy produktu.

„Dowolny film” określa kierunek rozwoju. Odbiór kolejnych wersji opiera się na
jawnych scenariuszach, a nie na niemożliwej do sprawdzenia obietnicy uniwersalności.

## 2. Dwa niezależne wejścia: forma i treść

**Źródło formatu** mówi, jak film wygląda i działa: układ, warstwy, animacje,
rytm, zasady napisów. Może to być referencja albo wcześniej zapisany format.
Gdy użytkownik ma tylko scenariusz, agent proponuje format do akceptacji.

**Źródło treści** mówi, co film przekazuje: własne nagranie, podcast, wywiad,
demonstracja bez audio, research lub scenariusz. Źródeł może być kilka.
Ten sam plik może pełnić obie role, ale system musi rozróżniać je jawnie.

Format nie jest sztywną kopią czasów referencji. Zachowuje reguły i charakter,
natomiast czas nowego odcinka wynika z jego wypowiedzi i wybranych fragmentów.
Animacja werdyktu w rankingu wiąże się z werdyktem w nowym nagraniu, nie ze starą sekundą.

## 3. Scenariusze, które mają korzystać ze wspólnych umiejętności

| Scenariusz | Materiał | Praca narzędzia | Oczekiwany wynik |
|---|---|---|---|
| Nowy odcinek w cudzym formacie | Referencja i własny temat/scenariusz | Odczyt formatu, nowa treść, generowanie i montaż | Własny film w rozpoznawalnym formacie |
| Ranking z własnym prowadzącym | Format tier listy i nagranie z kamery | Wybór wypowiedzi, cięcia, przypisanie obiektów i werdyktów, animacje | Rzeczywista osoba i wypowiedzi opakowane w format |
| Podcast / wywiad → short | Długi materiał własny lub wskazany linkiem, format | Wybór spójnego fragmentu, przekadrowanie, montaż, napisy | Krótki film zachowujący sens wypowiedzi |
| Demonstracja bez audio → omówienie | Film pokazujący funkcje, bez ścieżki mowy | Rozumienie obrazu i napisów, scenariusz, dobór fragmentów, lektor lub prezenter | Omówienie zsynchronizowane z tym, co rzeczywiście pokazuje demonstracja |
| Film z researchu lub scenariusza | Ustalenia z Astros albo tekst użytkownika | Plan scen, wybór formatu, pozyskanie/generowanie elementów, montaż | Film realizujący zadany przekaz |

To scenariusze jednego produktu. Nie budujemy pięciu niezależnych pipeline’ów.
Nie każdy film potrzebuje ASR, generowanego prezentera ani wyboru fragmentów.

## 4. Etapy i bramki użytkownika

Poniżej katalog etapów, z którego koordynator wybiera potrzebną ścieżkę.
Istniejący zatwierdzony format zachowuje akceptację swojej rewizji: odczyt i kontrola
zgodności zastępują powtórne oglądanie referencji, tworzenie podglądu i akceptację.
Analiza materiału do odcinka jest opcjonalna; temat lub gotowy scenariusz mogą
wystarczyć. Wypełnienie slotów szablonu może wystarczyć bez agenta wybierającego
ujęcia i cięcia. Szczegółowe reguły doboru: [GRAPH-DECISION §3](GRAPH-DECISION.md).

1. **Przyjęcie zadania.** Agent porządkuje źródła, ich role i oczekiwany rezultat.
   Dopytuje tylko o informacje, których nie ma w materiale ani kontekście.
2. **Przygotowanie formatu.** Odczytuje referencję lub dobiera zapisany format.
   Tworzy tani, ruchomy podgląd z placeholderami: układ, napisy, przejścia,
   przykładowe zachowanie elementów. Bez generowania finalnego prezentera i obrazów.
3. **QA formatu.** Osobny recenzent oraz sprawdzenia programowe oceniają podgląd
   względem referencji i wymagań. Wykonawca poprawia go w ograniczonej pętli.
4. **Akceptacja formatu przez użytkownika.** Użytkownik widzi działający podgląd,
   może go poprawić rozmową, a potem zatwierdzić konkretną wersję.
5. **Przygotowanie odcinka.** Agent wybiera fragmenty, tworzy brakującą treść,
   przypisuje źródła do scen i buduje podgląd montażu. Sprawdza sens i zgodność
   z materiałem. Proponowana bramka przed kosztownym generowaniem: podgląd treści
   i montażu, plan generowania oraz przewidywany koszt, jeśli można go wyliczyć.
6. **Produkcja.** Po akceptacji agent generuje potrzebne elementy, składa film,
   sprawdza render i poprawia wykryte problemy w zakresie zatwierdzonego planu.
7. **Odbiór filmu.** Użytkownik ogląda wynik, zgłasza poprawki lub akceptuje eksport.

Obowiązkowe bramki z wypowiedzi użytkownika: nowy/zmieniony format i film po QA.
Dodatkowa bramka odcinka/kosztu jest propozycją; nie oznacza pytania o każdą operację.
Placeholder pozwala ocenić format, ale nie dowodzi jakości finalnego głosu,
prezentera ani zgodności wszystkich wygenerowanych ujęć — te ocenia późniejsze QA.

## 5. Graf pracy i podział odpowiedzialności

```text
zadanie + istniejące wyniki → koordynator → wybór potrzebnych etapów
 format: zapisany LUB nowa analiza/QA/akceptacja
 treść: gotowa LUB scenariusz [z analizą materiałów, gdy potrzebna]
 plan odcinka → QA → akceptacja treści/kosztu [propozycja]
             → sloty [generacja i montaż, gdy potrzebne]
             → kompozycja → render → QA ↔ poprawa właściwego etapu → odbiór
```

Rozumienie referencji jest częścią analizy formatu. Analiza treści odcinka dotyczy
osobnego zadania: co wyjaśnić albo które fragmenty wykorzystać. Mogą współdzielić
obserwacje tego samego źródła. Niezależne analizy mogą działać równolegle. Produkcja
niezależnych elementów także, po zatwierdzeniu ich planu. Montaż zależy od gotowych
elementów i czasów wypowiedzi. Nie równoleglimy zadań przez omijanie tych zależności.

**Koordynator** wybiera strategię i zleca etapy. **Specjaliści** analizują format,
rozumieją treść, planują montaż lub przygotowują elementy. **Recenzent** dostaje
wymagania, materiał i wynik, a nie tylko zapewnienie wykonawcy o sukcesie.
To osobne odpowiedzialności i konteksty; nie musi to oznaczać różnych modeli.
Cięcia, pomiary, walidacja i render pozostają narzędziami, nie osobnymi agentami.

Każdy etap ma zapisane wejścia, wersję wyniku, kryteria odbioru i limit prób/kosztu.
Ponowienie zmienia dowody, plan lub wykonanie, zamiast powtarzać identyczne żądanie.
Wyczerpanie limitu daje jawny problem lub wariant uproszczony do decyzji użytkownika.
Awaria nie może uruchamiać bez końca generowania. Wynik nieznanego wywołania
kosztowego wymaga rozstrzygnięcia, zanim zostanie ono ponowione.

Akceptacja dotyczy wersji wyniku. Zmiana treści przelicza zależny montaż; zmiana
formatu unieważnia zależne kompozycje. Ukończone i nadal zgodne elementy są używane
ponownie. Restart zachowuje stan oraz oczekiwanie na akceptację.

## 6. Granice w kodzie — proponowane moduły

| Moduł | Odpowiedzialność i wynik | Istniejący punkt oparcia |
|---|---|---|
| Projekt i wykonanie | Graf, stan, wersje, akceptacje, limity, wznowienie | Lokalne bramki `omniwatchNode`; wymagają szerszej orkiestracji |
| Rozumienie źródeł | Treść, transkrypcja, zdarzenia wizualne, referencje do fragmentów | Capture, transcript, cues; docelowo granica integracji z OmniWatch |
| Formaty | Opis formatu, parametry, placeholdery, biblioteka | Blueprint, measure, motion, template i starsze formats |
| Plan odcinka | Sceny, fragmenty źródłowe, nowy tekst, reguły dopasowania czasu | Episode i brief Directora; obecna podmiana wartości nie wyczerpuje zakresu |
| Operacje na mediach | Cięcia, kadrowanie, audio i mapowanie czasu źródła na wynik | Istniejące operacje filmowe; kandydaci do integracji oceniani osobno |
| Generowanie | Adaptery głosu, prezentera, obrazów i klipów | Produce, voice, b-roll oraz integracje Directora |
| Kompozycja i render | Oś czasu, warstwy, napisy, animacje, plik końcowy | Compose, recipe, HyperFrames |
| QA i korekty | Sprawdzenia techniczne i ocena treści/obrazu, lista poprawek | Verify i ewaluacje; ich dotychczasowe ograniczenia opisuje STAN |

To granice modułów, nie osiem usług ani osiem osobno wydawanych pakietów.
Połączenia przez wersjonowane dane: projekt, format, indeks materiałów, plan
odcinka, lista operacji montażowych, zestaw elementów i raport QA.
Agent może zaproponować operację, ale wykonuje ją narzędzie po walidacji kontraktu.
Wybór biblioteki grafu pozostaje do przeglądu technicznego. Dawne uzasadnienie
„jedenaście kroków w sekwencji” nie opisuje całego nowego zakresu z gałęziami,
akceptacjami i wznowieniem.

## 7. Kolejność dopracowania i podział pracy

Proponowana kolejność, do akceptacji jako całość:

1. **Kontrakty i przykłady odbioru.** Rozdzielić źródło formatu od treści; zapisać
   wyniki etapów i kryteria dla scenariuszy z §3. Wyjaśnić relację dwóch bibliotek formatów.
2. **Tani format od początku do akceptacji.** Referencja → podgląd z placeholderami
   → QA → poprawka rozmową → zatwierdzona, zapisana wersja. Pierwszy samodzielny rezultat.
3. **Benchmark istniejących przypadków Hypit.** Ranking, podcast i sonda uliczna:
   sprawdzić rozpoznanie, zapis/odczyt własnego formatu i podgląd. Warianty zmian
   sprawdzają zrozumienie intencji i plan zmian; jakość fotorealistycznej generacji
   jest osobnym, późniejszym pomiarem. Pierwszy POC nie wymaga nagrania Jana.
4. **Podcast / wywiad → short.** Na ustalonym materiale z YouTube sprawdzić
   wybór fragmentów i osób, kadrowanie, napisy i zastosowanie formatu podcastu.
   OpenShorts jest wskazanym kandydatem do wykonania tej części; jego integracja
   i zgodność z kontraktem wymagają osobnej oceny.
5. **Qwen + short Juliana → omówienie.** Zbudować format z referencji Juliana,
   zrozumieć i pociąć niemą prezentację Qwena, przygotować prezentera w HeyGen,
   zsynchronizować pokaz i napisy, zmontować MP4. To docelowy pełny test integracji.
6. **Pełniejsza generacja i wejścia z researchu/scenariusza.** Spiąć te same etapy
   z istniejącymi integracjami Directora, a następnie dopracować obie powierzchnie aplikacji.

Po uzgodnieniu kontraktów niezależne tory to: formaty/podgląd, analiza i cięcia
materiału, wykonanie z akceptacjami oraz QA z materiałami odbiorowymi. Adaptery
generowania można rozwijać obok nich. Integracja pełnego filmu wymaga ich wspólnego
kontraktu i przechodzi odbiór jako całość; same testy modułów nie wystarczą.

Następny dokument: specyfikacja zachowania na tych scenariuszach, potem plan
techniczny z właścicielami plików, zależnościami i zadaniami. Nie zlecamy jeszcze
implementacji tego produktu. Autonomiczne wykonanie OmniWatcha pozostaje oddzielone.

## Źródła i status dowodów

- Wypowiedź Jana z 2026-09-22: cel, scenariusze, automatyzacja, wbudowani agenci,
  tani podgląd, QA, akceptacje oraz potrzeba dekompozycji.
- [Punkt wyjścia](START.md): istniejąca aplikacja i dotychczasowe ustalenia.
- [STAN](../../agent-os-module/docs/STAN.md): aktualny zapis stanu technicznego.
- [GRAPH-PLAN](../../agent-os-module/docs/GRAPH-PLAN.md): wcześniejsze lokalne bramki i placeholdery.
- [Analiza konkurencji](../../RESEARCH-CLONE-ARCHITECTURES.md): zapisane wnioski, bez nowej weryfikacji ofert i licencji.

Nie wykonano nowych testów, generacji ani renderów w ramach tego dokumentu.
