# OmniWatch — zatwierdzony projekt techniczny

Data: 2026-09-22. Kontekst: [SPEC](SPEC.md), [PLAN](PLAN.md).
D1–D11 zostały zaakceptowane przez użytkownika. Po akceptacji użytkownik polecił
rozdzielić pracę równolegle; [zlecenia i kolejność](work-orders/README.md) określają
warunki startu. Ścieżki nowych modułów są projektowane; funkcje nie są jeszcze wdrożone.

## Decyzje i kompromisy

| ID | Wybór | Powód i koszt |
|---|---|---|
| D5 | Proces roboczy Node uruchamiany na żądanie; panel i Hermes zlecają tę samą pracę | Skan nie zależy od karty ani restartu panelu; dochodzi jawna obsługa startu, zakończenia i wersji procesu. Bez osobnego serwera kolejki i stale działającego demona |
| D6 | Jeden pakiet ESM, `tsc`, `npm pack`; adapter `node:sqlite`; Node 22.22.3+ w linii 22 oraz linia 24 objęte testami | Brak natywnej zależności npm do kompilacji na komputerze odbiorcy; SQLite w Node 22 nadal ma status eksperymentalny. Ryzyko ograniczamy małym adapterem i testami obu linii; instalator odrzuca nieobsługiwane wersje |
| D7 | Oddzielne analizy Markdown w wydzielonym katalogu istniejącego Vaulta; wyszukiwanie i odpowiedzi przez adapter pamięci gospodarza | Bez drugiej bazy wiedzy. Potrzebny test na czystym Agent OS, bo lokalna instalacja autora nie dowodzi zgodności wydania |
| D8 | Ręczny skan i Scout współdzielą kolekcję, wybór materiałów, limity i wykonanie; zakres zależy od możliwości źródła | Zachowujemy wiele platform bez fałszywej obietnicy pełnego archiwum każdego serwisu. Pełne archiwum YouTube jest pierwszym obowiązkowym odbiorem kanału |
| D9 | Małe adaptery zgodności; jawny kontekst rozmowy, klasy błędów i granica z produkcją filmów | Chronimy wydaną betę i obecnych konsumentów TS; przejściowo pozostają cienkie pliki zgodności, ale jedna implementacja analizy |
| D10 | Testy zachowania ze stubami + rzeczywiste procesy/SQLite/Vault + mały zestaw ewaluacji modelu | Płatne testy tylko w bramce wydania i przy zmianie zachowania modelu, nie przy każdym refaktorze; instalację sprawdzamy poza maszyną autora |
| D11 | Jedna aktywna analiza na lokalny katalog danych, ograniczone strony wyników, kontrola cache i budżetu | Mniejsza przepustowość dużych archiwów, ale przewidywalne użycie komputera i prostsze odzyskiwanie pracy. Bez rozproszonej infrastruktury |

D6 opisuje docelowy zakres wsparcia, nie wynik już wykonanych testów. Na potrzeby
wydania manifest wskazuje dokładne przetestowane wersje Node i narzędzi. Dokumentacja
[Node 22 SQLite](https://nodejs.org/download/release/v22.22.3/docs/api/sqlite.html)
potwierdza dostępność bez flagi i synchroniczne API; nie nazywamy go stabilnym.

## Co wykorzystujemy z istniejącego kodu

| Istniejący element | Dalsza rola |
|---|---|
| `agent-os-module/src/lib/omniwatch.ts` | Wydzielenie pobierania, podziału, uploadu, promptów, streamingu i statystyk; konfiguracja/ścieżki/zapis poza rdzeniem |
| `omniwatchI18n.ts`, `omniwatchPresets.ts` | Zachowanie języków i presetów; mapowanie publicznych trybów summary/teardown do legacy ask/teardown |
| `omniwatchChannel.ts`, `omniwatchX.ts`, `omniwatchAds.ts`, części `omniwatchScout.ts` | Zachowanie adapterów listowania; wspólne identyfikatory, informacja o zakresie i koszcie, usunięcie obowiązkowego rankingu zwycięzców z normalnego skanu |
| `OmniWatchView.tsx`, `ChannelScan.tsx`, `ScoutView.tsx`, `OmniMarkdown.tsx` | Dostosowanie istniejących widoków, bez pełnego redesignu; źródło pozostaje przypisane do własnej karty |
| `omniwatchJobs.ts` | Obecny magazyn RAM zastępuje adapter operacji SQLite **tylko dla analizy**; konsumenci produkcji filmów zinwentaryzowani przed zmianą wspólnego API |
| `hermes/omniwatch-scout.py` | Cienki launcher wspólnego CLI, bez zależności od działającego HTTP panelu i bez własnego silnika |
| `app.py`, `omniwatch.py`, `static/` | Frontend pozostaje; Python uruchamia Node; mapowanie danych legacy według D2 |
| Host `config.vaultRoot`, `vault.ts`, klient modelu gospodarza | Adapter pamięci: odczyt/wyszukiwanie notatek i odpowiedź z odsyłaczami; bez kopiowania prywatnego Vaulta autora |
| Obecne testy `node:test`, szczególnie `card-source.test.mjs` | Zachowanie testu izolacji filmów i idiomu testów; narzędzia testowe w repo, bez pożyczania TypeScriptu z instalacji autora |

Odczytany stan: repo `e6ede85`, lokalny Agent OS `1d712eb` plus możliwe lokalne zmiany.
Nie jest to deklaracja, że te wersje są czystą lub oficjalną instalacją gospodarza.
Nie uruchomiono produkcyjnego instalatora ani zewnętrznego modelu podczas planowania.

## Granice kodu i pakowanie

```text
packages/omniwatch/src/
  contracts/   wejścia, wyniki, błędy, porty adapterów
  sources/     identyfikacja/listowanie/pobieranie materiałów
  analysis/    podział, model, summary/teardown, kontekst rozmowy
  storage/     SQLite, migracje, bufor, referencje
  collections/ plan skanu, aktualizacje, wznowienie
  runtime/     przejmowanie pracy, cykl procesu, CLI

agent-os-module/   Next UI/API + konfiguracja, Vault, Hermes
apps/standalone/   HTTP/SSE + konfiguracja i lokalne pliki
app.py, omniwatch.py  -> cienkie launchery kompatybilności
```

Jedno `package.json` biblioteki, wersja i tarball; moduły nie są osobnymi paczkami.
Root workspace służy budowaniu/testom. `exports` udostępnia kontrakty i jawne entrypointy;
nie importujemy wnętrza pakietu przez przypadkowe ścieżki. Kod biblioteki nie importuje
Next, React, Hermesa, konfiguracji hosta ani rendererów. CLI jest częścią tej samej paczki.
`tsc` tworzy JS i deklaracje, [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)
tworzy tarball. Instalator używa lokalnej paczki z wydania, nie workspace symlinku.

Wydanie zawiera analizę i jej adaptery, nie kopię całego `src/lib`. Manifest jawnie
wymienia pliki modułu i zależności. Czysta instalacja nie uruchamia patcherów Directora.
Istniejąca instalacja z produkcją filmów nie traci swoich route'ów wskutek usuwania
całego `/api/omniwatch`; instalator aktualizuje tylko własne pliki z manifestu.
Pliki wspólne z drugim projektem mają adapter zgodności i test konsumentów; jeśli
nie można ich odseparować bezpiecznie, wydanie blokuje się na tej granicy, nie na
poprawianiu jakości samego klonowania.

## D5: wykonanie i cykl życia

```text
panel Next / standalone HTTP -> przyjęcie zadania w SQLite -> 202 + ID
                                             |
Hermes -> Python launcher -> to samo CLI -----+-> start procesu roboczego
                                                      |
                                  przejęcie kolejki i operacji -> analiza
                                                      |
                                 bufor -> adapter zapisu -> referencja
                                                      |
panel: odczyt postępu po ID <---------------------- SQLite
Hermes: oczekiwanie po ID -> krótki raport nowych wyników / błędu
```

- Proces roboczy korzysta z tej samej paczki i katalogu danych co zlecający adapter.
  `spawn` z listą argumentów, bez powłoki; sekrety nie trafiają do argv ani SQLite.
  Adapter przekazuje niesekretną lokalizację konfiguracji. Proces sam ładuje właściwą
  konfigurację gospodarza lub standalone. Hermes przekazuje ID kolekcji, nie prompt.
- Samo zamknięcie karty kończy odpytywanie, nie anuluje zadania. Proces roboczy nie
  dziedziczy strumieni panelu; start i przeżycie restartu rodzica są testowane na
  macOS i Windows. Uruchomienie ma mieć potwierdzenie gotowości; błąd startu pozostawia
  zadanie oczekujące z widoczną przyczyną, nie fałszywe „działa”.
- Jeden konsument na `dataDir`. Krótka transakcja obejmuje przejęcie roli z unikalnym
  tokenem procesu; każdy zapis statusu wymaga aktualnego tokenu. Heartbeat co 5 s,
  po 30 s bez sygnału UI pokazuje problem. Wygasły heartbeat sam nie uprawnia do
  powtórzenia wywołania; odzyskanie uwzględnia potwierdzenie zakończenia starego procesu.
- Proces kończy się po opróżnieniu kolejki. Przyjęcie każdej nowej pracy wywołuje
  sprawdzenie/start konsumenta; transakcyjny protokół kończenia i ponowna kontrola po
  starcie nie pozwalają zostawić zadania bez konsumenta w wyścigu „enqueue kontra exit”.
- Po restarcie systemu odzyskanie inicjuje start aplikacji lub kolejne wywołanie Hermesa.
  Nie instalujemy systemowego demona ani nowego crona. D3 reguluje niepewne operacje;
  brak automatycznego wznowienia w czasie, gdy ani aplikacja, ani Hermes nie działają.
- Pauza/anulowanie zapisuje żądanie i zatrzymuje nowe wywołania; już wysłana operacja
  może dokończyć się i zostać zapisana. Anulowanie jednego przebiegu nie anuluje pracy
  potrzebnej drugiemu. Dostarczenie już opłaconego wyniku nadal jest dozwolone.
- Aktualizacja wstrzymuje nowe zlecenia i czeka na zakończenie bieżących operacji.
  Nie zabija modelu w celu szybkiego przełączenia wersji. Snapshot wykonania zawiera
  model/parametry, tekst i wersję szablonów promptów, politykę podziału/próbkowania
  oraz utrwalone wiadomości już rozpoczętych prób. Nowe wydanie deklaruje obsługiwane
  wersje tego kontraktu. Preflight sprawdza wszystkie niezakończone operacje, także
  wstrzymane: zgodny runtime wznawia stary snapshot, nie podstawia nowych promptów;
  niezgodny blokuje aktualizację do zakończenia lub jawnego zamknięcia tych operacji.
  Starą paczkę i kopię stanu zachowujemy również dla zależnych wstrzymanych operacji,
  nie tylko do końca procesu. Migracje schematu wykonujemy przy zatrzymanych konsumentach;
  niezgodność schematu blokuje start. Odbiór: pauza → zgodna aktualizacja → wznowienie
  bez zmiany requestów oraz odmowa aktualizacji nieobsługującej starego kontraktu.

Osobny proces nie obiecuje pracy przy wyłączonym komputerze. CLI i panel nie tworzą
nowego sieciowego API roboczego. Test procesu jest wymagany; sam wybór opcji `detached`
nie jest dowodem poprawności cyklu życia na wszystkich systemach.

## Kontrakty, identyfikatory i ponowienia

| Kontrakt | Reguła |
|---|---|
| `AnalysisRequest` | `sourceRef`, `mode: summary/teardown`, `focus`, `question`, `language`, `analysisVersion`, opcjonalne `conversationId` + `parentTurnId`; źródło i parametry nie zmieniają się po przyjęciu |
| `SourceRef` | Platforma + ID dostawcy gdy dostępne; inaczej hash kanonicznego URL; zachowanie znaczących parametrów URL. Brak pobranej wersji materiału nie oznacza fikcyjnej pewności o jego niezmienności |
| `analysisKey` | Skrót kanonicznej reprezentacji źródła/wersji i pełnych ustawień, bieżącego pytania i kontekstu; unikalny indeks w lokalnej bazie, nie porównanie tytułów |
| `Run` / `RunItem` | Snapshot wybranych materiałów, wyzwalacz, postęp, status enumeracji i limity; pozycja odwołuje się do współdzielonej operacji |
| `Attempt` | Osobny rekord każdego wywołania modelu, także części i merge: zamiar, rozpoczęcie, odpowiedź, użycie, nieznany wynik |
| `MemoryRef` | ID analizy, typ adaptera, ścieżka względna/anchor i fingerprint; żadnej dowolnej ścieżki przekazanej z przeglądarki |
| `Progress` | Etap, licznik materiałów, wersja zdarzenia, ewentualna nieukończona odpowiedź; „ukończono” dopiero po potwierdzonym zapisie |
| `Usage` | Użycie raportowane przez dostawcę, osobno szacunek i koszt nieznany; brak metryki nigdy nie staje się zerowym kosztem |

Schemat startowy: `schema_migrations`, `collections`, `runs`, `run_items`, `operations`,
`attempts`, `deliveries`, `conversation_turns`, `runtime_owner`, `reports`. Tabele są wewnętrzne;
kontrakty API nie ujawniają schematu. `deliveries` przechowuje także treść oczekującą
na zapis; po potwierdzeniu i okresie odzyskiwania zostaje referencja, nie pełna biblioteka.
Indeksy: unikalny klucz operacji i dostarczenia, `(state, created_at)`, `(run_id, ordinal)`,
`(conversation_id, parent_turn_id)`. Foreign keys i krótkie transakcje; WAL na lokalnym
dysku, `synchronous=FULL`, ograniczone oczekiwanie na blokadę. Kopia bazy uwzględnia WAL;
nie kopiujemy samego żywego pliku `.sqlite` jako rzekomo pełnego backupu.

Wznowienie nie podbija wersji promptu/modelu w zapisanym skanie. Nowa wersja rdzenia
nie uruchamia ponownie historii. Zmiana celu tworzy jawny nowy zestaw analiz; wymuszone
przeliczenie to nowa generacja, a nie usunięcie starych wyników. Mapowanie legacy ID
nie dowodzi zgodności dawnego promptu: stare pliki pozostają dostępne, bez wymyślania
brakujących parametrów i bez ponownego analizowania przy samej migracji.

Klasy błędów: `invalid_input`, `missing_config`, `source_unavailable`, `rate_limited`,
`provider_rejected`, `outcome_unknown`, `storage_unavailable`, `delivery_conflict`,
`runtime_unavailable`, `budget_paused`, `incomplete_listing`. Każdy błąd ma komunikat,
ID pracy i dozwoloną czynność odzyskania. Wyjątki nie są pochłaniane przez `.catch(() => {})`.

D9 usuwa automatyczne powtarzanie przerwanego streamu modelu z obecnego `streamOmni`.
Ponawiać automatycznie można odczyt postępu i bezpieczne pobranie metadanych; dla płatnego
provider call tylko przy potwierdzonym niewysłaniu/odrzuceniu bez wykonania. Timeout,
5xx i urwany stream same nie są takim dowodem. Zachowujemy częściowy tekst z oznaczeniem
niekompletności. Jawne ponowienie niepewnego wywołania ostrzega o możliwym drugim koszcie.
Próba wymaga poprawnego zakończenia protokołu odpowiedzi, nie samego zamknięcia socketu.

## D7 i D9: wiedza oraz rozmowa

Nowe analizy w Agent OS: domyślnie `OmniWatch/Analyses/<analysisId>.md` względem
`config.vaultRoot`; katalog wybierany w adapterze i zapisany w konfiguracji. Metadane:
ID, source URL/platform/ID, title, mode, focus, language, analysisVersion, createdAt,
conversation/parent ID, zakres analizowanych części i odsyłacze z czasami. Nazwa pliku
nie pochodzi z niesprawdzonego tytułu. Wikilinki prowadzą do indywidualnych analiz;
nie generujemy opracowań tematów ani nie przenosimy istniejących notatek użytkownika.

Zapis używa pliku tymczasowego w tym samym katalogu i bezpiecznego zatwierdzenia.
Istniejący plik o tym samym ID i zgodnej treści oznacza zakończone dostarczenie;
rozbieżna treść lub cudza edycja daje konflikt zamiast nadpisania. Po zmianie/usunięciu
notatki UI pokazuje niedostępną referencję; nie analizuje ponownie źródła samoczynnie.
Zmiana `vaultRoot` nie oznacza automatycznego kopiowania wiedzy do nowego Vaulta.

Adapter pamięci wystawia `writeAnalysis`, `readAnalysis`, `searchAnalyses`,
`answerFromAnalyses`. Wykorzystuje odczyt i wyszukiwanie gospodarza, ograniczone do
katalogu OmniWatcha. Odpowiedzi korzystają z treści znalezionych notatek i jawnych
odsyłaczy, nie samych tytułów. Przy braku dowodów pada „nie znalazłem tego w analizach”.
Nie uruchamiają narzędzi opisanych w filmie. Nie ma automatycznej syntezy całego kanału.

Lokalne `hermesApollo.ts` wyszukuje słowa kluczowe i ma heurystykę wyboru pytań do
Vaulta. Nie zakładamy, że pytanie po polsku samo tę heurystykę uruchomi. W adapterze
OmniWatch wywołanie wyszukiwania jest jawne; klient modelu pozostaje klientem gospodarza.
Jeżeli stockowy host nie udostępnia odpowiedniego interfejsu, W4 dodaje cienki adapter
korzystający z jego konfiguracji i notatek. Nie zastępuje pamięci własnym RAG/vector DB.
Odbiór musi wykazać działanie na konkretnej czystej wersji hosta przed oznaczeniem A10.

Rozmowa o jednym filmie ma `conversationId` związane z jego źródłem oraz kolejne
`parentTurnId`. Model otrzymuje bieżące pytanie i właściwe wcześniejsze wypowiedzi,
w tym wskazaną odpowiedź, oraz potrzebny materiał wideo; cache ogranicza ponowne
pobieranie, ale kolejne pytanie może kosztować nowe wywołanie modelu. Nie obiecujemy
zerowego kosztu doprecyzowań. Równoległe pytania do tej samej odpowiedzi są osobnymi
gałęziami; nie wybieramy „ostatniej odpowiedzi” globalnie z karty innego filmu.
Pole `focus` przechowuje opcjonalny temat streszczenia, a `question` konkretne pytanie.
Adapter starego `q` mapuje pierwsze zapytanie na focus w summary lub question w teardown;
dalsze `q` zawsze na question z parentTurnId. W kluczu uwzględniamy oba pola i historię.
Nowe API przyjmuje je oddzielnie; nie odgaduje intencji na podstawie treści pytania.

Kontekst ma limit zależny od limitu wejścia wybranego modelu po odjęciu materiału
wideo i rezerwy odpowiedzi. Przekroczenie daje prośbę o wskazanie fragmentu lub nową
rozmowę, bez cichego gubienia odpowiedzi, do której użytkownik się odnosi. Nie dodajemy
kolejnego płatnego modelu tylko do streszczania historii. Zakończone odpowiedzi zapisuje
adapter wiedzy; SQLite służy odtwarzaniu aktywnej rozmowy i referencji.

## D8: skan, źródła i harmonogram

- Adapter źródła deklaruje: pojedynczy film, listowanie, zakres archiwum, paginację,
  ewentualny koszt listowania. Zachowujemy działające URL YouTube/TikTok/Instagram/X
  oraz materiały wideo Meta Ads; adapter Meta Ads zachowuje rozwiązywanie ID reklamy
  do materiału, nie traktuje strony reklamy jak bezpośredniego pliku wideo.
- Pierwszy test pełnego kanału: YouTube, w tym duplikaty między videos/shorts.
  Dostęp do innych archiwów zgodny z realnym limitem adaptera; Instagram „25 ostatnich”
  nie dostaje etykiety „cały kanał”. Lista źródeł i ograniczeń jest widoczna przed startem.
- Listowanie zapisuje pozycje przyrostowo do SQLite, ze statusem `complete`, `partial`
  lub `failed` i kursorem, jeśli źródło go daje. Bez kursora ponownie enumeruje metadane
  i deduplikuje, bez ponownej płatnej analizy. Limit jednego requestu/strony nie ogranicza
  całego wybranego archiwum: następne partie są częścią tego samego przebiegu.
- Nowe materiały wybiera się po stabilnych ID, nie samej dacie ani rankingu. Podczas
  listowania baza blokuje duplikaty. Błąd jednej pozycji nie usuwa dobrych wyników;
  awaria zapisu nadal wstrzymuje dalszą płatną pracę zgodnie z D3.
- Zmiana tematu dotyczy treści streszczenia. Filtrowanie po tytule przed analizą może
  być opcją użytkownika, nie domyślną gwarancją rozpoznania tematu bez obejrzenia filmu.
- Hermes przechowuje cron i strefę czasową; OmniWatch przechowuje kolekcję, ustawienia
  i ID harmonogramu. Jedna komenda `scan --collection <id>` dla ręcznego wywołania i crona.
  Każde wykonanie używa snapshotu ustawień. Edycja crona nie tworzy drugiej kopii.
- Raport harmonogramu zawiera liczbę nowych analiz, źródła i odsyłacze; brak nowych
  materiałów kończy się ciszą. Błąd, pauza budżetu i niekompletny skan są raportowane
  jawnie. Wygasłe oczekiwanie launchera nie uruchamia nowej pracy, tylko podaje ID.
- Końcowy raport jest trwałym rekordem `reports` z runId i statusem pending/handed_off/
  confirmed/failed. Przy kolejnym uruchomieniu ten sam launcher najpierw odbiera
  niedostarczone raporty poprzednich przebiegów, potem zleca nową aktualizację. Tak
  raport ukończony po timeoutcie dociera najpóźniej przy następnym aktywnym cron run;
  nie dodajemy kolejnego harmonogramu. `report --run <id>` odczytuje lub ponawia sam
  raport na żądanie bez nowych wywołań analizy. Wyłączenie harmonogramu pozostawia
  raport dostępny w UI i tej komendzie.
- Zapis na stdout launchera oznacza przekazanie Hermesowi, nie potwierdzone odebranie
  wiadomości. Potwierdzenie/błąd dostarczenia odczytuje adapter, o ile dana wersja
  Hermesa je udostępnia. Bez takiego sygnału UI pokazuje „przekazano Hermesowi”
  i pozwala ponowić jawnie; nie zgaduje sukcesu. Błąd przekazania zachowuje pending
  do następnego uruchomienia. Awaria między przekazaniem i oznaczeniem może powtórzyć
  raport (stabilny runId), ale nigdy analizę. Test obejmuje timeout, późniejsze
  ukończenie, kolejny cron, błąd przekazania i ręczne ponowienie raportu.

## D11: wydajność, koszty i lokalne bezpieczeństwo

Domyślnie jedna analiza i jedno wywołanie modelu naraz na `dataDir`, w tym części
jednego filmu. Interaktywne pytanie ma pierwszeństwo przed **następnym** filmem skanu;
nie przerywa bieżącego płatnego wywołania. Zwiększenie współbieżności później wymaga
pomiarów, nie wchodzi do krytycznej ścieżki wydania.

Lista wyników: strony po 50 metadanych, treść analizy dopiero po otwarciu; postęp
nie przesyła wszystkich tekstów całego kanału. Polling co 2 s przy aktywnej karcie,
po błędach backoff do 15 s, po zakończeniu stop. Migawka streamu maksymalnie co 500 ms,
nie zapis każdej litery. Wideo jest plikiem/strumieniem, bez wczytywania całości do RAM.

Domyślny cache mediów: 10 GiB i 7 dni, konfigurowalny; dane bety wyłączone z nowego
automatycznego sprzątania. Nie usuwamy plików aktywnych operacji, wyników, bufora
niedostarczonych analiz ani Vaulta. Przy braku miejsca pauza z instrukcją zwolnienia.
Kopie wyników w buforze dostarczenia można usunąć po 24 h od potwierdzenia zapisu;
referencje i historia operacyjna pozostają. Kolejna rozmowa może wymagać pobrania
wideo po wygaśnięciu cache — nie usuwa to poprzednich odpowiedzi.

Czas oczekiwania: jawne timeouty pobierania/ffmpeg, połączenia modelu i bezczynności
streamu, konfigurowalne i testowane wstrzykniętym zegarem. Timeout modelu prowadzi do
`outcome_unknown`, nie automatycznej kolejnej próby. Logi ograniczone rozmiarem,
bez tokenów API, podpisanych URL uploadu ani pełnej treści prywatnego Vaulta.

Przed skanem użytkownik zatwierdza liczbę materiałów i szacunek; płatne listowanie
wymaga osobnego jawnego startu, także jeśli dotychczas uruchamiało się przez GET.
Harmonogram zachowuje zgodę i limity w swojej konfiguracji. Domyślnie 10 nowych filmów
na uruchomienie cykliczne; reszta zostaje w planie jako oczekująca na następny
przydział limitu, z jawną informacją, bez pominięcia. Konsument nie może opróżnić
tego backlogu ponad zgodę bieżącego przebiegu; następne uruchomienie wybiera także
wcześniejsze, jeszcze nieprzetworzone ID.
Pełny pierwszy skan działa partiami bez tego limitu harmonogramu, w zatwierdzonym zakresie.
Limit kosztu używa rezerwacji szacowanego maksimum przed wywołaniem i rozliczenia
po odpowiedzi; jeśli oszacowanie nie jest wiarygodne, automatyczny skan zatrzymuje
się do decyzji. Nie sprzedajemy szacunku jako gwarantowanego limitu rachunku dostawcy;
ścisłe limity konta ustawia się również u dostawcy. Zmiana cen nie jest zakodowana w UI.

To lokalna aplikacja jednego użytkownika. Zachowujemy uwierzytelnianie gospodarza;
standalone binduje loopback i sprawdza Host/Origin przy operacjach zmieniających stan.
Nie dodajemy publicznego serwera roboczego. URL i ID przechodzą walidację wspólną dla
CLI/API: dozwolone platformy/protokoły, brak lokalnych adresów docelowych i przejść
po ścieżkach. Parametry narzędzi przekazywane jako argv, nie shell. Odczyt plików
weryfikuje rzeczywiste położenie w dozwolonym katalogu, także przy symlinkach.
Treść filmu/notatki jest danymi do analizy, nie instrukcją wykonania poleceń lub eksportu
sekretów. Publiczny hosting i pełny model wieloużytkownikowy pozostają poza zakresem.

## Przegląd ustaleń i ryzyk

| Sekcja / ustalenie | Dowód | Rozwiązanie w projekcie |
|---|---|---|
| Architektura R1, P1, pewność 9/10: dwa silniki i granice dystrybucji | Python + TS; `omniwatch.ts:25` import blueprint, `install.sh:30` kopia całych libs | D1/D2/D4/D6/D9; ekstrakcja etapami, pakiet i adaptery |
| Architektura R2, P1, 9/10: stan i proces nie mają trwałego kontraktu | `omniwatchJobs.ts:26` Map, `:61` praca w procesie; PLAN wymaga wznowienia | D3/D5, test zabicia procesów i równoczesnego zlecenia |
| Architektura R3, P1, 9/10: zapis i pytania nie są odebrane jako biblioteka | `omniwatch.ts` logToVault dopisuje dziennik; host vault/Apollo mają własne reguły | D7, indywidualne referencje, jawne wyszukiwanie, stock fixture |
| Jakość R4, P1, 9/10: błędy zapisu i retry ukrywają ryzyko ponownego kosztu | `jobs/route.ts` save.catch, `channel/route.ts:182`; `streamOmni` ponawia Transient | D3/D9, rozdzielenie analizy/dostarczenia i wyniku nieznanego |
| Jakość R5, P1, 9/10: UI rozmowy nie zapewnia historii modelowi | `OmniWatchView.tsx:237` wysyła q/url, `omniwatch.ts:398` pojedyncza wiadomość | D9, parentTurnId, kontekst i izolacja filmu; A15 |
| Testy R6, P1, 8/10: brak wykazanego odbioru nowej architektury | Nowe pakiety/runner/SQLite nie istnieją; test karty pożycza narzędzia z hosta | D10, [TEST-PLAN](TEST-PLAN.md), instalacyjne E2E i ewaluacje |
| Wydajność R7, P2, 9/10: pełne wyniki w polling/history i nieograniczona enumeracja | ChannelProgress.results, listScans czyta cały JSON, listowanie all | D11, paginacja i trwała enumeracja, pomiary 10k pozycji |
| Wydajność R8, P1, 8/10: źródła mają różne koszty i zakres | X/Ads płatne listowanie, Instagram ograniczony; obecne komentarze mówią także „free” | D8/D11, capabilities, koszt listowania, limity i uczciwa kompletność |

Nie są to regresje spowodowane obecną zmianą: obecna zmiana dotyczy dokumentacji.
Ryzyka kompatybilności przy przyszłej migracji mają obowiązkowe testy w T0/T7/T8.
Nie ma potwierdzonego błędu wymagającego przebudowy całego hosta; lokalne heurystyki
Vaulta traktujemy jako ograniczenie integracji do sprawdzenia, nie ocenę całego Agent OS.
