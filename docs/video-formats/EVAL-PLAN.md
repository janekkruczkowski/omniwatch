# Formaty i evale — plan do przeglądu technicznego

2026-09-22. Wymagania i kolejność według korekty Jana. Propozycje kontraktu,
metryk i wykonania przygotowane do akceptacji zbiorczej. Nie uruchomiono nowych
evali, analizy filmów, generacji ani implementacji. To wejście do plan-eng-review,
nie raport ukończonego przeglądu.

## 1. Co sprawdzamy i w jakiej kolejności

1. Czy rozumiemy i zapisujemy format na tych samych filmach, dla których istnieją
   autorskie dane odniesienia Hypit: ranking, podcast, sonda uliczna.
2. Czy zapisany format da się ponownie wczytać i odtworzyć tanim podglądem.
3. Czy agent poprawnie planuje zmianę treści, osoby lub języka, zachowując wymagane
   elementy formatu. Fotorealizm generowanego hosta nie jest głównym kryterium.
4. Czy agent potrafi wybrać i zmontować fragment rzeczywistego podcastu z YouTube,
   poprawnie kadrując osoby i stosując format oraz napisy.
5. Czy potrafi stworzyć pełny film: niema demonstracja Qwena, format Juliana,
   prezenter HeyGen, zsynchronizowane cięcia i napisy, wynik MP4.

Własne nagranie Jana nie jest wymagane do tych odbiorów. Szerszy scenariusz pracy
na własnych materiałach pozostaje w koncepcji produktu.

## 2. Własny kontrakt: rekomendowany JSON

Istnieją `omniwatch.blueprint/1` i `omniwatch.template/1`, z walidacją, regionami,
ścieżkami, recipe i zachowaniem elementów. Nie wprowadzamy trzeciego konkurencyjnego
formatu od zera. Propozycja: rozwijać wspólny kontrakt na tej podstawie i zdefiniować
migrację starszej biblioteki `VideoFormat`, która nie zachowuje całego recipe/ruchu.
JSON jest rekomendacją; XML nie daje tu wykazanej korzyści wobec istniejącego kodu.

Rozdzielamy trzy dokumenty o odmiennym przeznaczeniu:

| Dokument | Zawartość |
|---|---|
| Obserwacja referencji | Wykryte elementy, geometria i zdarzenia z dowodami: plik, klatka, czas, metoda, niepewność |
| Format wielokrotnego użytku | Canvas, regiony i warstwy, style, sloty, zasady napisów, zachowania animacji i wiązania zdarzeń |
| Plan konkretnego odcinka | Nowa treść, źródła i ich fragmenty, przypisane osoby/assety, zdarzenia i rozliczona oś czasu |

Każdy dokument ma wersję schematu i stabilne identyfikatory. Format ma rewizję;
odcinek wskazuje dokładną rewizję. Eksport i import nie mogą gubić pól ruchu,
typografii ani referencji między elementami. Nieznana wersja jest błędem, a starsza
wspierana wersja przechodzi jawną migrację. Nie uruchamiamy kodu zawartego w danych.

Format przechowuje regułę „pokaż werdykt przy wypowiedzeniu oceny”, a obserwacja
także jej czas w referencji. Odcinek wylicza swój czas względem nowego materiału.
Nie przypisujemy nowych wypowiedzi na stałe do sekund starego filmu.
Brak danych oznacza `unknown`/brak wyniku z powodem; zero jest rzeczywistym zerem.

Minimalne grupy danych do uzgodnienia w schemacie:

```text
schemaVersion, id, revision
canvas
regions[id, role, rect, z, parent, paint]
styles + captionPolicy
slots[id, regionId, contentRole, allowedSources]
behaviors[eventAnchor, targetId, motion]
provenance + evidenceRefs
```

To szkic grup, nie gotowy JSON Schema. Szczegółowe typy mają wynikać z mapowania
istniejących Blueprint/Template i przypadków evali. Pochodzenie `measured`,
`inferred` i `authored` rozdzielamy; sama etykieta pochodzenia nie dowodzi jakości.

## 3. Stały benchmark, niezależny od wykonawcy

W repo są 13 przypadków opisanych w `test/eval/sources.json`, obejmujących trzy
unikalne filmy. Obecne pięć przypadków `extract` zawiera trzy warianty tej samej
referencji rankingowej. Raport pokazuje unikalne źródła i warianty osobno.

W `test/eval/ground/` są dane do oceniania: segmenty, słowa, podział napisów i spany.
Nie zakładamy, że zawierają pełny wzorzec geometrii, fontów i wszystkich czasów.
Brakujące etykiety dopisujemy jako zweryfikowane adnotacje z dowodem w materiale;
próg i zakres porównania są jawne. Autorski scenariusz i finalny film mogą się różnić.
Rozbieżność wymaga rozstrzygnięcia wzorca, a nie automatycznej kary dla ekstraktora.

Wzorzec jest wersjonowany i zamrożony przed eksperymentem. Model wykonujący
ekstrakcję nie otrzymuje oczekiwanych odpowiedzi ani plików oceny. Nie generujemy
wzorca od nowa tym samym modelem, który właśnie sprawdzamy.
Porównujemy znaczenie i mierzalne właściwości, nie nazwy pól naszego JSON-a z SVML.

Ponieważ te trzy filmy były już używane do strojenia, raport mierzy regresję
i zgodność na znanym zestawie, nie dowodzi działania na dowolnym filmie.
Nowa referencja Juliana rozszerza pokrycie; po użyciu do strojenia także jest
przypadkiem regresyjnym, a nie niezależnym testem uogólniania.

## 4. Warstwy evali i koszt

| Warstwa | Co uruchamia | Czego dowodzi | Kiedy |
|---|---|---|---|
| E0: kontrakt i replay | Zapisane odpowiedzi narzędzi, walidacja, zapis/odczyt, budowa planu | Zmiana kodu nie zgubiła danych ani zachowania; bez płatnych API | Przy zmianach kodu/kontraktu |
| E1: świeża ekstrakcja | Nowy model/prompt analizuje ustalone filmy i zapisuje wynik | Czy konfiguracja rozpoznaje lepiej/taniej; bez generacji wideo | Przy zmianach modelu, prompta, próbkowania lub narzędzi analizy |
| E2: tani podgląd | Render krótkich fragmentów z placeholderami, kontrola klatek i czasu | Zapisany format rzeczywiście steruje kompozycją | Po E0/E1, dla zmian formatu/renderera |
| E3: planowanie i rozumienie zmian | Agent dostaje cel, istniejące wyniki lub konkretną zmianę; zwraca plan/odcinek | Dobrał potrzebne umiejętności i zależności, pominął zbędne kroki, zmienił właściwe sloty | Przy zmianach koordynatora/planera/promptów |
| E4: montaż podcastu | Wybrane nagranie, wybór fragmentu, śledzenie/kadrowanie osób, napisy | Działają operacje na prawdziwym materiale i zastosowanie formatu | Przy zmianach tej strategii/integracji |
| E5: Qwen + Julian + HeyGen | Pełny proces z bramkami, produkcją i MP4 | Zintegrowany scenariusz kończy się użytecznym filmem | Kamień milowy i istotne zmiany całego przepływu |

Replay nie sprawdza nowego modelu. E1 kosztuje wywołania analizy; „tani” nie znaczy
„bezpłatny”. Cache jest powiązany z hashami wejścia, prompta, modelu/konfiguracji
i wersji narzędzi. Porównanie modelu nie może użyć odpowiedzi poprzedniego modelu.
Zamrożone ASR lub inne wejścia są dozwolone w porównaniu wyizolowanego etapu,
ale raport musi wskazać, którą część procesu rzeczywiście sprawdzono.

Każdy eksperyment zapisuje: rewizję kodu i wzorca, hash materiałów i promptów,
identyfikator modelu oraz dostępne parametry, liczbę prób, użycie, koszt i czas,
błędy, wynik per metryka/per przypadek oraz różnicę względem konfiguracji bazowej.
Koszt zawiera poprawki i QA. Brak informacji o cenie to `unknown`, nie 0.

Propozycja oszczędnej procedury: jeden przebieg przesiewowy; tylko obiecujące
konfiguracje porównać parami z bazową na trzech powtórzeniach tych samych źródeł.
To pomiar wstępnej zmienności, nie dowód istotności statystycznej. W miarę dostępności
utrwalić seed; nie zakładać, że zapewnia deterministyczność dostawcy.
Wybieramy najtańszą konfigurację spełniającą progi jakości i limit błędów,
a nie tę z najniższym kosztem pojedynczego nieudanego wywołania.

## 5. Metryki, które odpowiadają na pytanie o rozumienie formatu

- Struktura: poprawne role i liczba regionów, relacje panel/komórka, kolejność
  warstw, brak wymyślonej planszy. Dopasowanie po roli i relacji, nie przypadkowym ID.
- Geometria: błąd położenia/rozmiaru i pokrycie regionów, osobno dla napisów,
  prowadzącego i prezentacji; tolerancje względem rozdzielczości/obszaru.
- Napisy: zgodność tekstu, podział na porcje, pozycja, styl i wyróżnienia,
  synchronizacja do słów. Liczyć zarówno pominięcia, jak i nadmiarowe podziały;
  samo trafienie granic wzorca może nagradzać zbyt wiele cięć.
- Zdarzenia: kolejność i kotwice wejścia/wyjścia, związek grafiki z wypowiedzią;
  taka sama liczba obrazków nie dowodzi poprawnego przypisania.
- Zapis/odczyt: zachowanie wszystkich istotnych własności oraz odtworzenie podglądu
  bez ponownej analizy referencji.
- Zmiana odcinka: wymagane pola zmieniły się, chronione pozostały; nowe napisy
  pasują do nowej treści. Oceniana jest rzeczywista zmiana, nie sama nazwa `swap-*`.

Numeryczne tolerancje muszą być zdefiniowane i zamrożone przed porównaniem kandydatów,
po przeglądzie jakości adnotacji. Obecne progi są historycznym punktem startu,
nie potwierdzeniem kompletności metryk. Nie dobieramy ich po obejrzeniu wyniku kandydata.

## 6. Poprawność samego harnessu

Do E3 dodajemy ocenę decyzji koordynatora na zamrożonych wejściach. Przypadki:
gotowy format + temat; gotowy format + komplet treści/assetów; format + podcast;
nowa referencja + Qwen; gotowy format + wcześniej przeanalizowany Qwen; jedno źródło
w dwóch rolach; poprawka samego napisu. Wzorzec określa wymagane wyniki i zależności,
zbędne operacje oraz warunki ponownego wykorzystania. Dopuszcza równoważne plany,
zamiast wymagać identycznej listy kroków czy nazw agentów.

Mierzymy pominięcia potrzebnych operacji, niepotrzebne wywołania, poprawność
zależności i akceptacji, ponowne użycie wyników oraz koszt planowania/wykonania.
Tani plan z pominiętym obowiązkowym QA nie przechodzi. E0 sprawdza wykonawcę tych
planów na atrapach: liczba wywołań analizy, generacji i montażu musi odpowiadać
rzeczywistym potrzebom. Nowy model koordynatora przechodzi świeży E3, nie sam replay.

STAN §7 dokumentuje ograniczenia istniejących skryptów: możliwe wywołania grounding
w pozornie offline eval-text, zero ocenionych przypadków bez porażki, pomijanie
błędów wykonania i brak rzeczywistych podmian w `swap-*` eval-generate.
To wymagania dla wiarygodności benchmarku, nie osobny backlog napraw całej aplikacji.

Wymagany przypadek zakończony błędem lub bez oceny blokuje zielony wynik.
Raport rozdziela `pass`, `fail`, `error`, `not_scored`; przyczyna jest obowiązkowa.
Zero ocenionych przypadków nigdy nie jest sukcesem. Przerwany przesiew może
zatrzymać dalsze koszty, ale nie staje się pełnym raportem regresji.
Każda obowiązkowa metryka musi być policzona lub jawnie blokować odbiór.

Kontrola podglądu ma korzystać także z walidacji deterministycznej i zweryfikowanych
adnotacji. Ocena tym samym ekstraktorem źródła i własnego renderu jest pomocnicza:
oba przebiegi mogą popełniać ten sam błąd.

## 7. Konkretne nowe źródła i pełny scenariusz

- Materiał treści: [demonstracja Qwena](https://x.com/Alibaba_Qwen/status/2086664887560970531?s=20).
  Ten sam identyfikator jest w DESIGN §3: zapis testu z 2026-09-20 opisuje analizę
  materiału bez napisów. Brak audio pochodzi z obecnego opisu użytkownika;
  brak ścieżki napisów sam w sobie nie dowodzi braku dźwięku.
- Referencja formatu: [short Juliana](https://youtube.com/shorts/Xu0JinVn_Fg).
  Według użytkownika: podział ekranu, prezentacja 16:9 u góry, prowadzący i napisy.
  Geometria, rytm i style są jeszcze do zmierzenia, nie do wpisania na podstawie domysłu.
- Podcast: źródło do wybrania i zamrożenia przed E4. Joe Rogan był przykładem,
  nie wyborem konkretnego odcinka. Odbiór obejmuje dobór osób, stabilne kadrowanie,
  synchronizację i zachowanie sensu wypowiedzi. OpenShorts ma być oceniony jako
  adapter operacji; planner projektu zachowuje odpowiedzialność za wynik.

```text
short Juliana → obserwacja → format JSON → tani podgląd → QA → akceptacja
Qwen → zdarzenia wizualne + dowody → scenariusz i wybór fragmentów
                   ↓ połączenie ze wskazaną rewizją formatu
plan odcinka → QA treści → akceptacja przed produkcją
            → HeyGen + cięcia prezentacji → czasy mowy → napisy → kompozycja
            → render → QA całości → poprawki → odbiór MP4
```

Każde twierdzenie o demonstracji ma referencję do zdarzenia/fragmentu.
Głos opisuje to, co widać w odpowiednim momencie; czytelność prezentacji jest
oceniana po umieszczeniu jej w małym obszarze shorta. Żadne napisy źródłowe ani
głos Juliana nie są automatycznie traktowane jako nowa treść odcinka.

Próba odczytu obu linków przez web w tej sesji nie zwróciła treści filmów
(X: 403; YouTube: cache miss). Nie deklarujemy ich nowego obejrzenia.
Dokładna obserwacja i utrwalenie wejść są zadaniem przygotowania fixture’ów.

## 8. Podział przygotowania technicznego

1. Kontrakt formatu i migracja istniejących reprezentacji.
2. Zestaw źródeł, stabilne adnotacje i metryki, niezależne od wykonawcy.
3. Harness replay/live, rejestr eksperymentów, porównanie jakości i kosztu.
4. Tani podgląd, QA i akceptacja formatu.
5. Planowanie zmian i integracja montażu podcastu.
6. Pełna integracja Qwen/Julian/HeyGen oraz odbiór.

Po uzgodnieniu kontraktów prace 2–3 i 4 mogą postępować równolegle; 5–6 korzystają
z ich wyników. Na tym etapie zapisujemy plan, nie uruchamiamy wykonawców.
