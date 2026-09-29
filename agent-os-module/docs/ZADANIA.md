# OmniWatch — szkic technicznego podziału prac

> **Status: materiał pomocniczy, nie aktywny plan.** Użytkownik wskazał, że luki
> techniczne nie są teraz głównym problemem. Poniższa kolejność i priorytety były
> propozycją z przeglądu i nie określają dalszych prac. Najpierw trzeba ustalić
> zakres wydania OmniWatcha do analizy i researchu. Użytkownik potwierdził dwa
> niezależne projekty: OmniWatch ma pierwszeństwo, a opisane tu klonowanie formatów
> jest odłożone. Kontekst: [wiki](../../.omc/wiki/omniwatch-cel-i-spolecznosc.md).

Data: 2026-09-22. Podstawa: [STAN.md](STAN.md), [wiki](../../.omc/wiki/index.md),
przegląd kodu i zapisanych raportów. To roboczy inwentarz techniczny; role poniżej nie oznaczają
uruchomionych agentów ani przydziału do konkretnych osób.

## Cel i zakres

Rozważany etap techniczny (odłożony): wiarygodnie zmierzyć format krótkiego filmu, zapisać go jako szablon
i użyć do nowego odcinka z własną treścią. Ranking, podcast i wywiad są trzema
przypadkami odbioru. Sam poprawny MP4 i zielone testy jednostkowe nie zamykają celu.

Ask/Teardown, Scout i starszy most do Directora pozostają osobnymi obszarami produktu.
Ich historycznych zadań nie włączamy automatycznie do stabilizacji klonowania.
Nowe funkcje: czatowa edycja szablonu i długi film → shorty czekają na ten etap.

## Źródła prawdy

| Pytanie | Dokument |
|---|---|
| Co działa i jakie ma ograniczenia? | [STAN.md](STAN.md); każdy wynik z datą i zakresem dowodu |
| Co robić teraz i kto posiada pliki? | Ten plik |
| Dlaczego tak to zaprojektowano? | Wiki, [IR-CONTRACT-V2.md](IR-CONTRACT-V2.md), [GRAPH-PLAN.md](GRAPH-PLAN.md) |
| Jakie wyniki uzyskano? | `test/eval/EVAL-TEXT.md`, `EVAL-GENERATE.md` i odpowiadające JSON-y |
| Skąd instalować? | `agent-os-module/`; instalacja Agent OS jest odbiorcą, a rozbieżności wymagają porównania przed synchronizacją |

Stare plany zachowujemy jako historię decyzji. Nie są aktywnym backlogiem.
Wiki pozostaje lokalne w ignorowanym `.omc/wiki/`.

## Punkt wyjścia z przeglądu

- Zapisane raporty z 22.09: ekstrakcja 5/5, generowanie 4/8. W tej sesji nie
  powtarzano pomiarów ani renderów. Powtórzono 12 plików testów jednostkowych: exit 0.
- `eval-text.mjs` wywołuje `measureBlueprint`, więc sam zapisany capture nie gwarantuje
  pracy bez sieci. Grounding ma własne rozwiązywanie kluczy; `--still` dotyczy obrazków.
- `eval-text.mjs` kończy się sukcesem także przy zerze ocenionych przypadków.
  Obie bramki mogą pominąć awarię pomiaru/budowania i ocenić wyłącznie pozostałe przypadki.
- `eval-generate.mjs` wywołuje CLI z `--source` dla każdego przypadku. Nazwy `swap-*`
  nie przekładają się na przekazanie `--content` czy nowego prowadzącego. Dotychczasowy
  raport jest dowodem porównania struktur, nie dowodem ośmiu rzeczywistych podmian.
- `caption-band` przyjmuje każde niepuste `origin`. Po nieudanych próbach i skanie
  kod zachowuje wejściowe pudełko z notatką `origin: guess`. Jawny komunikat jest,
  ale zgadnięta geometria nadal może trafić do dalszego przetwarzania.
- Moduł i instalacja: 58 identycznych plików, 6 różnych, 3 brakujące (lista w STAN).
  Przed zmianą dokumentacji Git pokazywał 69 plików po rozwinięciu katalogów untracked;
  dawne „39 plików” nie jest aktualnym inwentarzem.

## Proponowana kolejka techniczna — odłożona

| ID | Priorytet | Pakiet / właściciel odpowiedzialności | Zależności | Stan |
|---|---|---|---|---|
| O0 | P0 | Dokumentacja i lista zadań / koordynator | — | wykonane w tym przeglądzie |
| Q1 | P0 | Powtarzalna i uczciwa ewaluacja / właściciel ewaluacji | — | gotowe do podjęcia |
| M1 | P0 | Walidacja pasma napisów / właściciel pomiaru | — | gotowe do podjęcia |
| Q2 | P0 | Metryki dla podcastu i wywiadu / właściciel metryk | kontrakt wejścia z Q1 | gotowe po uzgodnieniu kontraktu |
| R1 | P1 | Eksperyment z krótkimi zmianami napisów / właściciel rytmu | zamrożone próbki | gotowe do podjęcia |
| I1 | P0 | Integracja i odbiór trzech formatów / integrator | Q1, M1, Q2; R1 jeśli daje poprawkę | oczekuje |
| D1 | P1 | Odtwarzalna instalacja / właściciel dystrybucji | I1 | oczekuje; inwentarz można zrobić wcześniej |
| A1 | P1 | Automatyczne wypełnianie decyzji ruchu / właściciel capture | I1 | do doprecyzowania po stabilizacji |
| P1 | P2 | Czatowa edycja szablonu / właściciel produktu | I1, D1 | później |
| P2 | P2 | Długi film → shorty / właściciel produktu | osobny zakres i zestaw oceny | później |
| P3 | P2 | Przegląd Ask, Scout i Directora / właściciel integracji produktu | osobny odbiór aktualnego runtime | później |

Q1, M1 i R1 mogą biec równolegle. Q2 może dołączyć po ustaleniu formatu fixture'ów.
Q1 i Q2 nie edytują wspólnie skryptu ewaluacji: Q2 dostarcza osobny moduł metryk,
a integrator wpina go po zakończeniu Q1. Właściciel R1 nie zmienia produkcyjnego
detektora przed wynikiem eksperymentu.

## Q1 — powtarzalna i uczciwa ewaluacja

**Własność:** `scripts/eval-text.mjs`, `scripts/eval-generate.mjs`, nowe
`test/eval-harness.test.mjs`, `test/eval/baselines/`, `test/eval/content/` i kontrakt
`test/eval/BASELINES.md`. Ścieżki w pakietach są względem `agent-os-module/`.
**Tylko odczyt:** CLI, biblioteka szablonów, biblioteka pomiaru, kontrakt IR.

Zapisać zweryfikowany wzorzec osobno dla każdego źródła: wersja schematu, identyfikator
lub hash źródła/capture, pochodzenie pomiaru. Ponowne uruchomienie nie może po cichu
odświeżać wzorca. Oddzielić ocenę zapisanych danych od pomiaru wymagającego providerów.
Brak fixture'a w trybie offline kończy się jawnym błędem, bez automatycznego wywołania API.

Status przypadku: pass / fail / error / skipped. Zero ocenionych przypadków, nieznany
`--case`, błąd renderu lub pomiaru nie może dać zielonej bramki. Raport musi pokazać
liczbę zadeklarowanych, uruchomionych i pominiętych przypadków; częściowy wynik nie jest
pełnym odbiorem. Zatrzymać się również po błędzie wykonania, chyba że podano `--all`.

Przypadki podmiany dostają własne, napisane przez nas treści wejściowe i asercję,
że treść wyjściowa faktycznie się zmieniła. Cudzy `ground/` pozostaje tylko do oceniania.
Oddzielić od tego test zachowania formatu z oryginalnym dźwiękiem i atrapą prowadzącego.

**Odbiór:** dwa przebiegi offline używają tego samego wzorca i nie wołają providerów;
testy negatywne łapią brak danych, błąd wykonania i pozorną podmianę treści.
**Test:** `node --test agent-os-module/test/eval-harness.test.mjs` (plik do utworzenia).

## M1 — pasmo napisów: pomiar, sensowność i degradacja

**Własność:** `src/lib/omniwatchMeasure.ts`, nowy `src/lib/omniwatchCaptionGate.ts`,
`test/measure-origin.test.mjs`, nowy `test/caption-gate.test.mjs`.
**Tylko odczyt:** Ground, BandScan, Cues, Blueprint, Compose.

Bramka ma sprawdzać geometrię względem płótna, zmierzonej typografii i polityki
dzielenia tekstu. Dłuższa treść może wymagać podziału na porcje, a nie odrzucenia
poprawnego pasma. Nie zakładać, że napisy zawsze muszą być na dole.

Odróżnić `located` (podpowiedź modelu), `scanned` (pomiar) i brak pomiaru. Po odmowie
zwrócić jawny stan degraded/hole; samo dopisanie notatki nie wystarcza do uznania
pudełka za poprawne. Zgadnięte pudełko nie może utrwalić się jako zaakceptowany wzorzec.
Zmiany potrzebne w innych plikach przekazać integratorowi.

**Odbiór:** wadliwy region ze STAN §3.2 nie przechodzi wyłącznie dzięki `origin`;
poprawny wąski napis jest dopuszczony, gdy pasuje do treści; brak pomiaru pozostaje
widoczny także dla konsumenta wyniku. Brak regresji rankingu i podcastu.
**Test:** `node --test agent-os-module/test/measure-origin.test.mjs agent-os-module/test/caption-gate.test.mjs`.

## Q2 — metryki dla formatów bez planszy

**Własność:** nowe `scripts/lib/format-metrics.mjs`, `test/format-metrics.test.mjs`,
`test/eval/metrics/`. **Tylko odczyt:** bramki, szablon, wzorce Q1.

Dostarczyć funkcję porównującą obecność, geometrię i czas widoczności prowadzących,
pokrycie napisami oraz ich rytm. Oddzielić cechy niezmienne formatu od dozwolonych
zmian treści; podmiana języka nie musi zachować liczby słów. Brak planszy oznacza
„nie dotyczy”, a nie dwie dodatkowe zaliczone metryki.

**Odbiór:** dobre fixture'y przechodzą; usunięta druga osoba, przesunięty napis,
brak napisów i zmiana czasu widoczności są wykrywane. Progi mają uzasadnienie
w danych i nie są obniżane dla uzyskania zielonego raportu.
**Test:** `node --test agent-os-module/test/format-metrics.test.mjs`.

## R1 — krótki eksperyment dotyczący rytmu wywiadu

**Własność:** nowy `scripts/experiments/caption-edges.mjs`, nowe fixture'y
`test/eval/caption-edges/` i `docs/EXPERIMENT-CAPTION-EDGES.md`.
**Tylko odczyt:** `omniwatchCues.ts`, BandScan, odrzucone hipotezy z wiki.

Sprawdzić, czy detektor zbocza w Cues scala sąsiednie zmiany krótsze niż 0,1 s.
Najpierw syntetyczne sekwencje z dwoma znanymi zdarzeniami, potem trzy lokalne filmy
przy zamrożonym paśmie. Oddzielnie raportować liczbę porcji, trafione granice i słowa.
Nie dobierać położenia pasma ani progu pod znaną liczbę 45.

**Odbiór:** hipoteza potwierdzona z pomiarem i propozycją poprawki albo odrzucona
z zapisaną granicą metody. Wynik negatywny również zamyka zadanie badawcze.
**Uruchomienie:** `node agent-os-module/scripts/experiments/caption-edges.mjs`
(narzędzie do utworzenia; bez wywołań modeli).

## I1 — integracja i odbiór

**Własność po przekazaniu pakietów:** wspólne pliki `omniwatchBlueprint.ts`,
`omniwatchGround.ts`, `omniwatchTemplate.ts`, `omniwatchCompose.ts`, `omniwatchCues.ts`,
`scripts/clone-film.mjs` oraz punkty integracji w bramkach i Measure.
Inni wykonawcy kończą edycje przed przejęciem tych plików.

Połączyć wyniki Q1/M1/Q2, ewentualną poprawkę R1 i sprawdzić zachowanie szablonu
bez ponownego pomiaru. Przechodzić od testów offline do klatek, a potem pełnego filmu.
Render wyjściowy może być mierzony ponownie; nie jest to powód do odświeżenia wzorca.
Powtarzalny wzorzec nie usuwa szumu pomiaru wyjścia — raport musi rozróżnić oba źródła błędu.

**Odbiór:** komplet zadeklarowanych przypadków oceniony, zero ukrytych awarii;
trzy formaty obejrzane; podmiana własnej treści udowodniona; napisy, warstwy,
ruch i audio zgodne z zadanym scenariuszem. Zachowane raporty, klatki i MP4.
Nie nazywać wersji z placeholderami finalnym filmem użytkowym.

## D1 — dystrybucja i zgodność instalacji

**Własność:** `install.sh`, `register-nav.py`, `patch-director.py`,
`patch-director-ui-v2.py`, `test/fresh-install.py`, nowy raport `docs/INSTALL-PARITY.md`.

Porównać sześć różnych plików z instalacją, zanim zostaną zastąpione; odzyskać ewentualne
poprawki istniejące wyłącznie w instalacji. Sprawdzić kompletność importów nowych modułów.
Przetestować świeżą instalację i drugie uruchomienie instalatora na kopii roboczej,
bez nadpisywania pracującego Agent OS. Instalację roboczą aktualizuje jeden integrator.

**Odbiór:** świeża kopia ma komplet plików, ponowne uruchomienie jest idempotentne,
typecheck i smoke przechodzą, a zakres lokalnych poprawek gospodarza jest jawny.
**Test:** `python3 agent-os-module/test/fresh-install.py` oraz typecheck kopii Agent OS.

## A1 i zadania późniejsze

`buildCapturePrompt` istnieje, ale wyszukiwanie w `src` i `scripts` nie wykazało wywołania
poza definicją. A1 ma sprawdzić produkcyjną ścieżkę capture i połączyć ją z decyzjami
ruchu oraz parserem. Przed implementacją ponownie potwierdzić lukę, bo starszy plan
miesza gotowy renderer z automatycznym pozyskiwaniem jego danych. Odbiór: film bez
ręcznie wpisanych decyzji ruchu, z weryfikowalnym źródłem kategorii i czasów.

P1 potrzebuje kontraktu dopuszczalnych zmian szablonu i cofania edycji. P2 potrzebuje
osobnego korpusu długich filmów oraz kryteriów wyboru i kadrowania shortów. P3 zaczyna
od aktualnego sprawdzenia działania, a nie kopiowania blokad z STATUS z 20.09.

## Zasady przekazania pakietu

Każdy wykonawca dostaje cel, powyższą własność plików, listę tylko do odczytu,
zależności, test i kryterium odbioru. Nie jest sam w repo: nie cofa cudzych zmian,
a potrzebę edycji cudzego pliku zgłasza integratorowi. Raport zapisuje do
`.omc/reports/<ID>.md`: zmienione pliki, wynik komendy i kod wyjścia, artefakty,
ograniczenia, wywołania providerów. Koordynator weryfikuje wynik uruchomieniem.

Statusy: gotowe do podjęcia → w toku → do odbioru → zamknięte, ewentualnie blokada
z podanym powodem. Sam raport autora nie zamyka zadania. Nowe decyzje aktualizują
STAN i tę kolejkę; wiki przechowuje uzasadnienie i link, bez drugiej kopii backlogu.
