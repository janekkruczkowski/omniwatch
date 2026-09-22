# OmniWatch — plan dostarczenia v0.2

Data: 2026-09-22. Status: **plan zatwierdzony; przygotowany podział pracy**, bez rozpoczętej implementacji.
D1–D11 zatwierdzone przez użytkownika 2026-09-22; po przedstawieniu całości
użytkownik polecił rozdzielić zadania do równoległej pracy.
Zakres produktu i kryteria A0–A15: [SPEC.md](SPEC.md).
Podział poniżej dotyczy OmniWatcha. Starszy `agent-os-module/docs/ZADANIA.md`
jest odłożonym inwentarzem projektu tworzenia filmów.

## Dokumenty wykonawcze

- [Projekt techniczny](TECHNICAL.md): decyzje D5–D11, kontrakty, runtime, pamięć, skany,
  zgodność, obsługa błędów i limity. D1–D11 są zatwierdzone; testy implementacji pozostają do wykonania.
- [Zadania i własność plików](TASKS.md): 10 zadań T0–T9, zależności i kolejność pracy.
- [Plan testów](TEST-PLAN.md): scenariusze użytkownika, awarie, ewaluacje i odbiór wydania.
- [Zlecenia wykonawcze i fale](work-orders/README.md): konkretne przydziały A–F,
  granice własności i warunki uruchomienia.
- [Zadania JSONL](tasks-eng-review.jsonl): ten sam backlog do użycia przez wykonawców.

Dokumenty są częściami jednego planu; zatwierdzenie oznacza akceptację ich spójnego
zakresu, nie publikację ani wykonanie migracji na danych użytkownika.

## Zasada kolejności

Najpierw potwierdzamy scenariusze użytkownika i granice wspólnego rdzenia.
Potem dostarczamy rozwiniętą wersję Agent OS i migrujemy **już wydany standalone**
na ten sam rdzeń. Płatny hosting jest osobnym, późniejszym etapem z zakresem do wyboru.
W czasie migracji samodzielna aplikacja pozostaje dostępna. Nie planujemy jej pierwszej
premiery ani nie uzależniamy wspólnego rdzenia od parytetu wszystkich funkcji.

Nie rozpoczynamy od przenoszenia całego repo, budowania chmury ani napraw klonowania.
Pierwsze wydanie musi jednak mieć wspólny, niezależny od gospodarza rdzeń, żeby nie
utrwalać trzeciej implementacji przy uruchamianiu hostingu.

## Etap 0 — zakres i granice

**Rezultat:** uzgodniona specyfikacja, zestaw pierwszych scenariuszy i decyzja
o sposobie współdzielenia kodu. Forma wiedzy jest już ustalona: osobne analizy,
wyszukiwanie i pytania; dla Agent OS zapis w jego pamięci. Podstawowy scenariusz
jednego filmu musi działać bez korzystania z biblioteki.

- Rozdzielić logicznie analizę i produkcję filmów; zinwentaryzować importy między nimi.
- Przypisać istniejące funkcje do: zachować, dostosować, przenieść do adaptera,
  pozostawić w projekcie filmowym. Nie usuwać działającej ścieżki filmowej przy porządkowaniu.
- Wpisać do kontraktu zachowania do zachowania: domyślne streszczenie, opcjonalny
  temat streszczenia, teardown i dalsze pytania po obu trybach (F1, F14–F16).
  Rozróżnić pytania o bieżący film od pytań do biblioteki Agent OS.
- Zapisać obecne API i dane wydanego standalone, które trzeba odczytać po migracji.
- Wykorzystać potwierdzony Obsidian Vault gospodarza (`config.vaultRoot`, Markdown,
  wyszukiwanie i wikilinki). Sprawdzić end-to-end pytania o zapisane analizy i zgodność
  ze stockową instalacją. Adapter używa Vaulta jako biblioteki; nie projektujemy drugiej
  bazy ani nie wymagamy prywatnego układu wiki Jana.
- Przygotować niewielkie fixture'y ilustrujące archiwum → aktualizacja dla celu prywatnego
  i zawodowego oraz film wymagający widzenia obrazu.

**Bramka:** zakres produktu i kontrakty są wystarczająco jasne do przydzielenia plików.
Zadania implementacyjne nie startują wyłącznie na podstawie nazw pakietów z tego planu.

## Etap 1 — wspólny rdzeń i jeden sposób przeglądania źródeł

**Rezultat:** moduł Agent OS korzysta z wydzielonego rdzenia; ręczny skan i Scout
wywołują tę samą operację z tymi samymi ustawieniami.

- Wydzielić silnik analizy z oboma trybami, ukierunkowaniem tematem i dalszymi
  pytaniami; zachować identyfikację źródeł, presety i pomiar użycia.
- Ustalić przekazywanie kontekstu doprecyzowań: obecne UI dalszych pytań nie dowodzi
  pełnej obsługi historii przez model. Odebrać odwołania do wcześniejszych odpowiedzi.
- Wyjąć z rdzenia klucze Hermesa, ścieżki Agent OS, Vault oraz zależność od klonowania.
- Wyciągnąć przebieg analizy partii z route'ów do wspólnej funkcji.
- Zastąpić wybór samych popularnych zwycięzców polityką źródeł i celu użytkownika.
  Ranking może pozostać opcją, ale nie steruje zwykłym zdobywaniem wiedzy.
- Dodać trwały plan przebiegu, identyfikację ukończonych analiz i wznowienie.
- Ujednolicić model wyników i referencji do pamięci. Trwały stan wykonania jest
  odrębny od biblioteki wiedzy; w Agent OS tę drugą zapewnia gospodarz.

**Bramka:** A0–A9 oraz A13–A15 w odpowiednim zakresie przechodzą na kontrolowanych danych;
test może uruchomić rdzeń bez Next.js, Hermesa, Vaulta i kodu generowania filmów.

## Etap 2 — wydanie dla społeczności Agent OS

**Rezultat:** odbiorca instaluje moduł i sam przechodzi oba scenariusze ze SPEC.

- Podstawowy widok: URL → domyślne streszczenie, opcjonalnie temat lub pytanie.
  Dostosować obecny start modułu z teardownu do streszczenia; zachować wybór teardownu
  oraz dalsze pytania po obu trybach, z widocznymi wcześniejszymi odpowiedziami.
  Kanał i aktualizacje są dodatkowymi ścieżkami, nie obowiązkowym onboardingiem.
- Dostęp do zapisanych analiz, wyszukiwania i pytań oprzeć na pamięci Agent OS.
- W Scout pokazać te same źródła, pytanie i język oraz ustawienia harmonogramu.
- Wpiąć pamięć Agent OS i dostarczanie wyników przez adaptery; błąd eksportu nie gubi analizy.
- Zachować prosty link z Astrosa i sprawdzić, że odświeżenie nie powiela płatnej pracy.
- Przygotować instalację samego OmniWatcha bez automatycznych zmian w Directorze
  i bez dołączania zależności rendererów projektu filmowego.
- Przygotować instrukcję instalacji, aktualizacji, konfiguracji kluczy i krótkie demo
  pokazujące zdobycie wiedzy, pierwszy skan oraz aktualizację.
- Przeprowadzić pilotaż świeżej instalacji, zebrać obserwacje i poprawić blokady użycia.

**Bramka wydania:** A0–A10 oraz A13–A15, kompletna dokumentacja instalacji i wynik pilotażu.
Publikacja paczki i komunikacja do społeczności są osobnymi działaniami wydaniowymi;
ten plan nie oznacza, że zostały wykonane.

## Etap 3 — migracja już wydanego standalone

**Rezultat:** istniejąca samodzielna aplikacja używa wspólnej logiki analizowania,
zachowując prostotę i zgodność. To kolejne wydanie produktu, nie jego pierwsza premiera.

- Dodać samodzielny runtime i adapter lokalnej konfiguracji/zapisu, bez Hermesa i Vaulta.
- Podłączyć istniejący frontend; zachować domyślne streszczenie pojedynczego filmu,
  ukierunkowanie tematem, teardown, dalszą rozmowę po obu trybach, języki i dotychczasowe wejścia. Nie wymuszać tworzenia kolekcji.
- Przenieść działanie `app.py`/`omniwatch.py` na wspólny silnik lub zapewnić adapter
  zgodności. Po odbiorze nie rozwijać drugiej implementacji analizowania.
- Zachować odczyt istniejących wyników, bez ich usuwania i ponownego płacenia za analizę.
- Sprawdzić instalację nowego wydania i aktualizację starego poza środowiskiem autora.

**Bramka:** A0, A1, A2, A9, A11, A13–A15 oraz regresja dotychczasowych funkcji. Kanały,
harmonogram i własna biblioteka nie są wymaganiem tego etapu. Współdzielimy
implementację funkcji, nie wymuszamy identycznej oferty obu aplikacji.

### Kompatybilność bety Pythona — wykonanie decyzji D2

Cel migracji: dotychczasowy użytkownik uruchamia nową wersję, ma swoją konfigurację
i zapisane analizy. Samo przejście na TypeScript nie pobiera ponownie filmów i nie
wywołuje modelu. Poniższe uszczegóławia zachowanie danych, komend i powrotu do starej
wersji już zawarte w D2 oraz zasadach migracji.

| Obszar | Stan bety — sprawdzony kod | Kontrakt migracji |
|---|---|---|
| Uruchomienie WWW | `uv run app.py`, lokalnie `127.0.0.1:8765` | Zachować komendę jako launcher Node i adres lokalny; brak Node/artefaktu zgłosić przed startem, z instrukcją instalacji; nie przełączać po cichu na stary silnik |
| CLI | `uv run omniwatch.py URL`, `-q`/`--question`, `--lang`, `--teardown` | Cienki launcher przekazuje argumenty jako listę do CLI Node, kod wyjścia i przerwanie; bez własnej analizy w Pythonie |
| Konfiguracja | `.env` obok skryptów; środowisko procesu ma pierwszeństwo | Zachować lokalizację i pierwszeństwo oraz `DASHSCOPE_API_KEY`, `DASHSCOPE_API`, `OMNI_MODEL`, `OMNI_LANG`, `OMNI_CACHE_HOURS`, `OMNI_MAX_FRAMES`; konfigurację podaje adapter standalone, bez szukania klucza w Hermesie |
| Analizy | `summaries/<id>.md`, kolejne pytania dopisywane jako sekcje | Zachować pliki i ich odczyt bez przeliczania; migracja nie przepisuje treści Markdown i nie wymaga doskonałego parsowania starych nagłówków |
| Materiały lokalne | `.cache/<id>/source.mp4`, `info.json`, części i klatki | Zachować dostęp do dostępnych plików przez adapter legacy; brak lub uszkodzenie cache nie usuwa analizy, a ponowne pobranie następuje dopiero dla zleconej operacji |
| Identyfikatory | Poza YouTube Python: skrót SHA-1; TS: własny hash djb2 | Lookup uwzględnia legacy ID; mapowanie nie zmienia starych nazw plików. Nie uznawać tych samych materiałów za nowe tylko dlatego, że zmienił się silnik |
| Metadane wideo | Python: `extractor_key`, opcjonalny `uploader`; TS: `extractor`, `channel` | Jawna normalizacja w adapterze bety, oryginalne dane pozostają czytelne dla starej wersji |
| Upload cache | Python `oss.json.at` w sekundach; TS w milisekundach | Czytać wersję legacy z właściwą jednostką; nie nadpisywać oryginalnego formatu metadanymi nowego runtime. Wygasłe/niepoprawne wpisy nie są traktowane jako ważny upload |
| Interfejs WWW | `/api/watch?url&q&lang&mode`, zdarzenia SSE, `/video/…`, `/frame/…`, `/i18n.json` | Adapter HTTP Node zachowuje wejścia i kształt odpowiedzi używany przez istniejący frontend; pełne zdarzenia `answer.text`, postęp, końcowe `done`, widoczny `error`, obsługa przewijania wideo |

Granica zgodności dotyczy udokumentowanego użycia aplikacji i danych użytkownika.
Wewnętrzne funkcje modułu Python nie są deklarowanym publicznym SDK; jeśli podczas
inwentaryzacji znajdziemy zewnętrznych konsumentów tych funkcji, zostają jawną kwestią
zgodności do rozstrzygnięcia, nie cichym usunięciem ich ścieżki.

Uwaga do dokumentacji bety: `.env.example` i README opisują `OMNI_PART_MINUTES`, lecz
sprawdzony kod dzieli według `OMNI_MAX_FRAMES`. Instrukcja migracji musi opisać tę
rozbieżność; nie wolno obiecywać zgodności z zachowaniem, którego sprawdzona beta nie ma.

```text
istniejąca beta + lokalne dane
              |
     sprawdzenie Node i plików wydania
              | błąd -> czytelna instrukcja; dane nietknięte
              v
     kopia konfiguracji i analiz + wykaz plików
              | błąd -> aktualizacja wstrzymana; beta nadal dostępna
              v
     nowy runtime + adapter danych bety
              | test nieudany -> powrót do poprzedniego wydania
              v
     odbiór danych, komend i obu trybów
              |
     dalsze używanie; nowe analizy na wspólnym silniku
```

Odbiór W6 obejmuje:

- Kopię instalacji bety z własną konfiguracją i zapisami dla YouTube oraz platformy
  spoza YouTube; sumy kontrolne starych analiz przed/po samej migracji są identyczne.
- Zero wywołań pobierania/modelu podczas migracji i odczytu zapisów; ponowne
  uruchomienie migracji nie dubluje zapisów ani mapowania legacy ID.
- Obie stare komendy, argument z polskimi znakami i spacjami, przekazanie błędu
  procesu oraz przerwania; brak Node nie uruchamia drugiej implementacji silnika.
- Stary frontend ze stubowanymi odpowiedziami przez nowy adapter HTTP: postęp,
  streszczenie/temat, teardown, dalsze pytanie, odsyłacz do klatki i końcowy błąd.
- Poprawny odczyt sekundowego `oss.json.at`, wygasły upload, brak `source.mp4`,
  uszkodzone `info.json` i niekompletne pliki instalacji; stare analizy nadal czytelne.
- Powrót do starego wydania z kopią danych; instrukcja określa zachowanie wyników
  powstałych już po migracji, bez ich kasowania podczas cofania wersji.
- Świeżą instalację i aktualizację na macOS i Windows, które wymienia obecny README.
  Dokładną wspieraną wersję Node ustala część dystrybucyjna przeglądu.

W6 odpowiada za adapter legacy, launchery i powyższy odbiór; W5 za paczkę i instrukcję
aktualizacji. Testy używają przygotowanych danych bez prawdziwego klucza API.
Nie odtwarzamy pełnej biblioteki z historycznych rozmów modelem podczas migracji.

## Etap 4 — zakres i pilotaż płatnego hostingu

**Rezultat:** wybrany i opisany model usługi dla osób, które nie chcą instalować aplikacji.

Najpierw decyzja produktowa, potem implementacja. Rozważane warianty:

1. Pojedynczy film → streszczenie (opcjonalny temat) lub teardown → dalsze pytania i pobranie wyniku.
2. Wiele filmów → osobne analizy → ZIP do pobrania, bez utrzymywanej biblioteki.
3. Trwała biblioteka użytkownika, kanały, wyszukiwanie i cykliczne aktualizacje.

Propozycja startowa to wariant 1. Nie jest jeszcze wybrany. Wariant 2 wymaga specyfikacji
paczki: osobne analizy, indeks, źródła i metadane; wiki tematyczne oznaczałoby dodatkowy
zakres. Wariant 3 wymaga zaprojektowania i utrzymywania pamięci użytkownika. Pamięć
Agent OS nie jest zasobem dostępnym automatycznie klientowi chmury.

Po wyborze wariantu:

- Określić cenę, zakres użycia, retencję wyników i model kluczy providerów.
- Zapewnić kontrolę dostępu do wyników, limity i rozliczenie; model kont dopasować do oferty.
- Sprawdzić pobieranie z chmury: działanie źródła na laptopie nie potwierdza działania
  z adresów centrum danych.
- Przeprowadzić ograniczony pilotaż przed udostępnieniem usługi szerzej.

**Bramka:** A12 doprecyzowane dla wybranego wariantu; znane koszty, retencja,
sposób pobrania wyniku i obsługa awarii. Kanały, ZIP i harmonogramy nie są domyślnie
włączone do zakresu. Decyzje te nie blokują wydania Agent OS.

## Organizacja techniczna — decyzje D1–D4 przeglądu inżynierskiego

**Uzgodnione 2026-09-22:** jedna wspólna biblioteka z oddzielnymi modułami wewnętrznymi.
Nie tworzymy osobno wydawanych paczek kontraktów, silnika i zapisu. Biblioteka ma
jeden artefakt wydaniowy i jedną wersję; moduły zachowują wyraźne odpowiedzialności.
**D2, zatwierdzone przez użytkownika:** TypeScript na Node, wydzielony z modułu
Agent OS. Samodzielna aplikacja była wydana jako beta w Pythonie; migracja jest
dopuszczona z zachowaniem konfiguracji, wyników i drogi aktualizacji. Python może
pozostać cienką warstwą uruchomieniową dla dotychczasowych komend, bez drugiego silnika.

```text
Agent OS: widok + API + Hermes      Standalone: istniejący interfejs
                \                     /
                 +-------------------+
                 | Wspólna biblioteka|
                 |                   |
                 | kontrakty         |
                 | źródła            |
                 | analiza i pytania |
                 | skany             |
                 | stan wykonania    |
                 +-------------------+
                          |
                 zapis przez adapter gospodarza
                  /                       \
         Obsidian Vault             istniejący zapis lokalny
           Agent OS                    standalone
```

Powyższe nazwy oznaczają moduły kodu. Zatwierdzony D5 w TECHNICAL wybiera proces roboczy
uruchamiany na czas pracy, wspólny dla panelu i Hermesa, bez serwera kolejki.
Zakres produktu pozostaje bez zmian: obsługa źródeł wielu platform, streszczenie,
temat, teardown, dalsze pytania oraz skany i harmonogram w Agent OS.

### Trwały stan pracy — zatwierdzona decyzja D3

**Uzgodnione 2026-09-22:** lokalny SQLite przechowuje zadania, postęp, identyfikatory
analiz i referencje do wyników. Plik `state.sqlite` leży w lokalnym katalogu danych
OmniWatcha wskazanym przez adapter gospodarza, **poza synchronizowanym Vaultem**.
Nie wymaga osobnego serwera. Obsidian Vault nadal jest biblioteką wiedzy Agent OS;
SQLite nie przejmuje wyszukiwania wiedzy ani rozmów z biblioteką.

Stan rozdziela przebieg skanu, jego pozycje i właściwe operacje analizy. Pozycje
dwóch przebiegów mogą wskazywać tę samą operację. Unikalny klucz operacji obejmuje
tożsamość i wersję materiału, tryb, temat/pytanie, język, wersję analizy oraz kontekst
rozmowy zgodnie ze SPEC §4. Ręczne uruchomienie i Hermes korzystają z tej samej bazy
i reguł przyjęcia pracy; dwa procesy nie mogą jednocześnie przejąć tej samej operacji.

Krótkie transakcje obejmują przyjęcie/przejęcie pracy oraz utrwalenie wyniku i zmianę
statusu. Pobieranie, wywołanie modelu i zapis do Vaulta odbywają się poza transakcją.
Transakcja SQLite nie obejmuje zewnętrznego dostawcy modelu ani plików Vaulta — nie
obiecuje dokładnie jednego wywołania po dowolnej awarii.

```text
przyjęcie i deduplikacja -> oczekuje -> przygotowanie materiału
                                              |
                                trwały zapis zamiaru wywołania
                                              |
                                      wywołanie modelu
                                              |
                             trwały bufor wyniku + zapis oczekujący
                                              |
                               zapis przez adapter pamięci
                                              |
                                    referencja -> ukończona

awaria przy możliwym wywołaniu -> wynik nieznany -> wymaga sprawdzenia
błąd zapisu gotowego wyniku   -> zapis oczekujący -> ponów tylko zapis
```

Przed płatnym wywołaniem utrwalamy jego zamiar. Po restarcie bezpiecznie wracają
operacje, o których wiadomo, że nie wysłały wywołania. Operacja z nieznanym wynikiem
wywołania wymaga sprawdzenia; sam upływ czasu lub utrata procesu nie powoduje kolejnej
płatnej próby. Ewentualne ponowienie wymaga jawnej decyzji użytkownika. Dotyczy to
także poszczególnych wywołań w analizie podzielonej na części i jej podsumowania.

Gotowy wynik trafia do trwałego bufora przed dostarczeniem do Vaulta. Adapter zapisu
używa stabilnego identyfikatora analizy, żeby ponowne dostarczenie po awarii nie
tworzyło drugiej notatki. Dopiero potwierdzony zapis utrwala referencję i kończy
operację. Bufor służy odzyskaniu i dostarczeniu wyniku, nie jest drugą biblioteką.

| Awaria | Wymagane zachowanie |
|---|---|
| Dwa równoczesne zlecenia tego samego materiału i ustawień | Jeden właściciel operacji; oba przebiegi odwołują się do jej wyniku |
| Restart przed wywołaniem modelu | Wznowienie tylko pracy potwierdzonej jako niewysłana; ukończone analizy pominięte |
| Restart podczas wywołania lub przed utrwaleniem odpowiedzi | Widoczny stan „wynik nieznany”; bez automatycznej ponownej płatnej próby |
| Vault niedostępny albo błąd jego zapisu | Wynik pozostaje w buforze; wstrzymanie kolejnej płatnej pracy do usunięcia błędu; ponowienie samego dostarczenia |
| Restart po zapisie notatki, przed zapisem referencji | Odszukanie zapisu po identyfikatorze analizy; bez duplikatu i bez ponownej analizy |
| Pełny dysk, błąd SQLite lub migracji schematu | Widoczny błąd i zatrzymanie dalszej płatnej pracy; żadnego cichego przejścia na stan w RAM |

W2 dostarcza wersjonowany schemat, migracje z kopią stanu i testy z wymuszonymi
awariami. Odbiór: restart w środku partii, dwa niezależne procesy zlecające tę samą
pracę, pełny dysk, niedostępny Vault i przerwanie między zapisem notatki a referencji.
Testy sprawdzają liczbę wywołań stubowanego modelu, zachowanie gotowej treści i brak
duplikatów, nie tylko statusy. W3 i W4 używają tego samego kontraktu.

D3 wybiera mechanizm trwałości. D6 w TECHNICAL wybiera adapter `node:sqlite` i testy
Node 22.22.3+ w linii 22 oraz linii 24; wymagana wersja zostaje sprawdzona przed instalacją.
Nie aktualizujemy po cichu Node gospodarza. D6 zatwierdzono wraz z całością planu.
Podstawa właściwości transakcyjnych: [SQLite — atomic commit](https://www.sqlite.org/atomiccommit.html).

### Dystrybucja wspólnej biblioteki — zatwierdzona decyzja D4

**Uzgodnione 2026-09-22:** gotowa, wersjonowana paczka biblioteki dołączona do wydania
OmniWatcha. Agent OS i standalone korzystają z dokładnie tego samego artefaktu.
Nie publikujemy osobnej paczki biblioteki w publicznym npm na tym etapie.

Proces wydania buduje TypeScript raz, pakuje wynik z deklaracjami typów i manifestem,
a następnie używa tej paczki w testach instalacyjnych obu aplikacji. Dopiero ten
sprawdzony artefakt trafia do archiwum wydania. Manifest określa wersję biblioteki,
wymagania Node, zależności uruchomieniowe i sumę kontrolną paczki. Konkretne wersje
środowiska wynikają z odbioru na wspieranych systemach; nie deklarujemy ich zgodności
wyłącznie na podstawie lokalnej instalacji autora.

```text
źródła jednej biblioteki -> budowanie i testy -> wersjonowana paczka
                                                       |
                                   +-------------------+------------------+
                                   |                                      |
                           instalacja Agent OS                   instalacja standalone
                                   |                                      |
                                   +---------- odbiór obu aplikacji -------+
                                                       |
                                           archiwum wydania OmniWatch
```

Użytkownik instaluje gotowy rdzeń z lokalnej paczki, bez kompilowania jego TypeScriptu.
Integracja Agent OS może nadal wymagać zwykłego przebudowania gospodarza; gotowy rdzeń
nie oznacza przenośnego pliku wykonywalnego bez Node ani instalacji bez zależności.

Instalator przed zmianami sprawdza kompletność paczki, wersję środowiska, wymagane
narzędzia oraz zgodność miejsca instalacji. Przygotowuje kopię zmienianych plików
i wykaz własności instalowanych plików. Zmiany użytkownika lub gospodarza kolidujące
z aktualizacją zgłasza jako konflikt; nie nadpisuje ich po cichu. Korzysta wyłącznie
z części wydania przeznaczonej dla analizy, zgodnie z etapem 2.

Uszkodzona paczka, niezgodne środowisko lub brak zależności zatrzymują aktualizację
przed przełączeniem aplikacji. Nieudany odbiór umożliwia powrót do poprzedniego
wydania z kopii plików. Dane użytkownika nie są usuwane przy cofnięciu; migracje
SQLite podlegają osobno zasadom D3, a dane bety zasadom D2.

W5 odpowiada za powtarzalny proces budowania, paczkę, manifest, instalator i instrukcję
aktualizacji/cofnięcia. Automatyczna weryfikacja wydania obejmuje świeży Agent OS,
świeży standalone, aktualizację bety oraz powrót do poprzedniej wersji. Sprawdza też
brak nadpisania zmienionego pliku gospodarza i przerwanie instalacji uszkodzonej paczki.
W6 dostarcza przypadki zgodności bety. Publikacja samego wydania pozostaje późniejszym
działaniem; zatwierdzenie planu nie oznacza wykonanej publikacji.

## Pakiety odpowiedzialności

Pakiety W0–W7 to obszary pracy, **nie osobno publikowane biblioteki**. Ścieżka
`packages/omniwatch/` jest roboczym miejscem jednej biblioteki TypeScript; nazwy
modułów opisują granice odpowiedzialności. Zlecenie musi wskazywać dokładne pliki do edycji.

| Pakiet | Właściciel roli | Własność i rezultat | Zależność |
|---|---|---|---|
| W0 | Koordynator produktu i architektury | `docs/omniwatch/`, mapa granic i kontrakt wewnątrz jednej biblioteki, roboczo `packages/omniwatch/src/contracts/` | Etap 0 |
| W1 | Silnik analizy | Proponowane `packages/omniwatch/src/analysis/`, `packages/omniwatch/src/sources/`; wydzielenie z `omniwatch.ts` i providerów; oba tryby, temat i kontekst dalszych pytań | W0 |
| W2 | Stan operacyjny i adaptery zapisu | Proponowane `packages/omniwatch/src/storage/`: lokalny SQLite (D3), migracje schematu, deduplikacja, bufor wyniku i referencje do pamięci; bez drugiej biblioteki dla Agent OS | W0 |
| W3 | Przeglądy i aktualizacje | Proponowane `packages/omniwatch/src/runtime/` i `collections/`; CLI/proces roboczy, wspólny przebieg kanału i aktualizacji; testy deduplikacji | Kontrakt W0, adaptery W1/W2 |
| W4 | Integracja Agent OS i UI | `agent-os-module/src/components/`, route'y: domyślne streszczenie, wybór teardownu i dalsza rozmowa; adapter pamięci: zapis, odszukanie i pytania; użycie istniejących możliwości gospodarza i wspólnego rdzenia | W1–W3, audyt pamięci |
| W5 | Instalacja i wydanie | D4: budowanie i pakowanie jednego artefaktu, manifest, instalator, rejestracja nawigacji, odbiór instalacji/aktualizacji/cofnięcia; przewodnik w `docs/omniwatch/install/` | W4/W6 do pełnego odbioru; proces pakowania wcześniej |
| W6 | Migracja samodzielnej aplikacji | Proponowane `apps/standalone/`, migracja wydanych `app.py`, `omniwatch.py`, `static/`; zgodność obu trybów, tematu streszczenia i dalszych pytań (A13–A15) | Odbiór rdzenia i runtime (T3); równolegle z integracją Agent OS |
| W7 | Hosting | Najpierw wybór wariantu usługi; potem proponowane `apps/cloud/` i adaptery właściwe dla wybranego zakresu | W6 i osobna specyfikacja oferty |

W1 i W2 mogą pracować równolegle po zamrożeniu kontraktu. W3 może tworzyć testy i
logikę przeciw stubom tych adapterów. W4 przygotowuje widoki po ustaleniu scenariuszy.
Dotychczasowe pliki silnika podczas ekstrakcji należą wyłącznie do W1; W3 zgłasza
potrzeby zmian zamiast dopisywać tam własny runner. W5 jako jedyny edytuje instalator.

Jeden integrator scala pakiety i aktualizuje testową instalację Agent OS. Raport wykonawcy
zawiera pliki, dowód działania, testy i ograniczenia. Gotowe oznacza wynik odebrany
w scenariuszu użytkownika. Ten dokument nie uruchamia agentów ani nie przydziela osób.

## Zasady migracji

- Zachować obecne dane i płatne artefakty. Pierwsza migracja pracuje na kopiach,
  ma wersję schematu oraz drogę powrotu do poprzedniego wydania.
- Nie przepisywać źródeł bezpośrednio w zainstalowanym Agent OS. Instalator ma
  odtwarzać wydanie ze źródła i zachowywać obce zmiany gospodarza.
- Dotychczasowe adresy i wejścia CLI zachować przez adapter zgodności tam, gdzie
  korzystają z nich odbiorcy. Zmianę wymagającą migracji jawnie opisać.
- Zgodność obu aplikacji sprawdzać kontraktowo, nie oczekując identycznego tekstu modelu.
- Wspólna paczka ma jedną wersję. D4 wybiera gotowy artefakt dołączony do wydania
  i instalowany w obu aplikacjach; bez ręcznie utrzymywanej drugiej kopii silnika.
- Nie uzależniać OmniWatcha od ukończenia rendererów, klonowania ani chmurowych płatności.

## Zatwierdzone wybory autora

D1–D4 są zatwierdzone: jedna biblioteka, TypeScript i zgodność bety, SQLite,
gotowy artefakt wewnątrz wydania. D5–D11 wybrane przez autora zostały zaakceptowane
w całości przed poleceniem podziału pracy:

| ID | Decyzja |
|---|---|
| D5 | Proces roboczy na czas skanu/analizy; panel i Hermes współdzielą kolejkę |
| D6 | Jeden pakiet ESM, tsc/npm pack, node:sqlite, sprawdzane wersje Node 22/24 |
| D7 | Osobne analizy w istniejącym Vaultcie, jawne wyszukiwanie i pytania z referencjami |
| D8 | Wspólne skany i aktualizacje, pełny kanał YouTube jako pierwszy odbiór; zachowane platformy zgodnie z możliwościami adapterów |
| D9 | Adaptery zgodności, kontekst dalszych pytań i jawne błędy; jedna implementacja silnika |
| D10 | Testy kontraktów/awarii/instalacji oraz ograniczone ewaluacje modelu i pilotaż |
| D11 | Jedna analiza naraz, paginacja postępu i kontrola cache/budżetu |

Szczegóły, ograniczenia i alternatywy wynikają z TECHNICAL; w szczególności prostsze
wykonanie wewnątrz panelu odrzucono ze względu na zależność długich skanów od jego
restartu. Dodatkowy natywny sterownik SQLite odrzucono na start ze względu na dystrybucję;
status eksperymentalny `node:sqlite` w Node 22 pozostaje jawnym kompromisem.

## Poza zakresem tego wydania

- Produkcja/klonowanie nowych filmów: drugi projekt, nie warunek jakości analizy.
- Cloud, konta, płatności, wieloużytkownikowa pamięć: wymagają osobnej decyzji produktowej.
- ZIP i wiki tematyczne: pomysł, nie zatwierdzony wynik skanu; wynikami są osobne analizy.
- Publiczne SDK/npm, rozproszona kolejka, osobny serwer DB i vector DB: brak potrzeby
  dla obecnego lokalnego produktu i wybranego sposobu dostarczenia.
- Nowy wygląd standalone i parytet kanałów/harmonogramów: migracja chroni proste użycie.
- Gwarantowane pełne archiwum każdego serwisu: nie obiecujemy danych, których adapter
  nie udostępnia. Zachowujemy istniejące platformy i jawnie opisujemy ich zakres.

Nie dopisano osobnego TODOS.md z niezatwierdzonym zakresem. Bieżące prace są w TASKS,
a powyższe pomysły pozostają odłożone z uzasadnieniem.

## Kolejność wykonania i odbiór

T0 zamraża kontrakty i fixture'y → T1 silnik i T2 stan równolegle → T3 runtime oraz
T4 Vault → T5 skany → T6 Agent OS/Hermes. T7 standalone może ruszyć po T3; T8 składa
i odbiera wspólne wydanie, T9 sprawdza jakość na próbkach i samodzielny pilotaż.
W5 może przygotować proces pakowania po T0; pełny odbiór czeka na obie powłoki.
Publikacja społecznościowa pozostaje pierwszym priorytetem. Detale i konflikty własności:
[TASKS](TASKS.md). Testy dopisuje się przy implementacji każdego modułu, nie na końcu.

Pierwsza demonstracja wewnętrzna: jeden URL → summary/temat/teardown → doprecyzowanie,
z wynikiem zachowanym po restarcie. Docelowe wydanie obejmuje też kanał, aktualizacje,
pamięć i Hermesa. Termin ustala wykonawca po T0 i sprawdzeniu czystej instalacji,
a nie na podstawie liczby istniejących plików.

Schematy przepływu i awarii są w D3/D4 oraz TECHNICAL. Przy implementacji komentarze
z diagramami trafiają do `runtime/runner`, `storage/operations` i `storage/delivery`:
przejęcie pracy, niepewny wynik modelu i granica między bazą a plikiem wiedzy.

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings |
|---|---:|---|---|
| Scope | 1 | D1 zatwierdzone; jedna biblioteka | Bez redukcji uzgodnionych funkcji |
| Architecture | 1 | Opracowane w D1–D9; plan zatwierdzony | 3 główne ustalenia R1–R3 |
| Code Quality | 1 | Projekt adapterów i obsługi błędów gotowy | 2 ustalenia R4–R5 |
| Tests | 1 | Diagram i plan testów zapisane, niewykonane | R6: 18 grup testów oraz 5 grup ewaluacji |
| Performance | 1 | Limity, paginacja i pomiary zaprojektowane | 2 ustalenia R7–R8 |
| Outside Voice — Claude Code | 1 próba | UNAVAILABLE — uwierzytelnienie | Brak zewnętrznego wyniku |
| Native second read | 1 + sprawdzenie poprawek | Ukończone; korekty potwierdzone w dokumentacji | 3 uwagi, wszystkie ujęte w projekcie |
| CEO review z wcześniejszej rozmowy | — | Nie oznaczono jako ukończony | Wcześniejsze decyzje produktowe użytkownika zachowane |

VERDICT: APPROVED PLAN — zatwierdzony do organizacji i realizacji według zależności; implementacja nie rozpoczęta.
OUTSIDE COVERAGE: unavailable (Claude Code); native fallback completed. CROSS-MODEL: not established.

Zakres wyłączony i istniejący kod opisane. 10 zadań wykonawczych, 6 strumieni po
fundamencie T0; równolegle A/B, następnie C/D i E według zależności. Brak nowych
nieobsłużonych cichych awarii w **projekcie**; nie jest to wynik testów przyszłego kodu.
Nie dodano osobnych TODO poza zakresem. Lake Score: N/A — wybory architektoniczne,
bez porównywania kompletności ze skrótami. Zbadano cztery sekcje przeglądu; nie
uznano pytań do użytkownika za konieczne po jego dyspozycji wspólnej akceptacji.

Walidacja dokumentów: poprawne lokalne linki, domknięte bloki, unikalne ID zadań
oraz spójny graf zależności. Nie uruchamiano instalatora, płatnych analiz ani testów
implementacji. Wyniki drugiego odczytu i ograniczenia zapisu globalnego dashboardu:
[REVIEW](REVIEW.md). Artefakty odbioru i backlog pozostają dostępne w repo.

NO UNRESOLVED DECISIONS
