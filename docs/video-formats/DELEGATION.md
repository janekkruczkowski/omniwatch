# Studio — autonomiczna delegacja do DeepSeek V4.1 Flash

2026-09-22. **ZAAKCEPTOWANE przez Jana, limit API 25 USD łącznie.**
Źródło: [ACCEPTANCE](ACCEPTANCE.md). Uruchomiono koordynatora `/root/studio_autonomous_delivery`; rekord: `delegation-run.json`.
Przyjęcie tego pakietu obejmuje rekomendacje D1–D12 z [TECHNICAL](TECHNICAL.md),
kolejność silnik → evale → minimalna obsługa procesu, poniższy podział i wybrany
budżet eksperymentów. Design UX1–UX9 oraz U1–U6 pozostają odłożone.

## Cel i odpowiedzialność

Jeden koordynator ma dostarczyć działający lokalny POC, a nie samo rozpisanie pracy:
własny wersjonowany format, analiza referencji, ponowne użycie formatu, opcjonalne
rozumienie materiału odcinka, dobór umiejętności, produkcja, korekty i wiarygodne
evale. Wykorzystuje istniejący prototyp zamiast przepisywać wszystko od zera.
Kolejność odbioru: Hypit (ranking/podcast/sonda) → planowanie → prawdziwy podcast
→ Qwen/Julian/HeyGen. Własne nagranie Jana nie jest wymagane.

Koordynator i wykonawcy: **DeepSeek V4.1 Flash**, dostępny profil narzędzia
`router_opencode_go_deepseek_v4_1_flash`, model `opencode-go/deepseek-v4.1-flash`.
Ten profil ma stałe myślenie `max`; nie opisujemy go jako konfigurowalnego `high`.
To wybór modelu wykonującego prace programistyczne, nie zamrożenie modeli produktu.
Modele analizy/planowania/generowania produktu pozostają wymienne i oceniane w evalach.

Root przekazuje zlecenie dopiero po akceptacji. Koordynator sam rozstrzyga zwykłe
decyzje implementacyjne, integruje, recenzuje i naprawia błędy. Root nie jest
bramką dla każdego PR, pliku, testu czy decyzji. Do Jana wracają gotowe wyniki
albo konkretny problem zewnętrzny, którego nie da się rozwiązać w przyjętym zakresie.
Nie tworzymy nowych zadań w pasku aplikacji ani cyklicznych powiadomień.

## Izolacja i punkt startowy — koordynator

Źródła tylko do odczytu: repo `video-watch`, jego `.omc/wiki`, STAN oraz wskazane
w dokumentacji pliki. Nie ingerować w pracę zespołu OmniWatcha ani żywy Agent OS.
Obecny HEAD nie zawiera całego prototypu: potrzebne są także wybrane niezacommitowane
pliki Template, pomiarów, renderera i evali.

Po akceptacji przygotuj osobny katalog roboczy:
`/Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/studio-autonomous`.
Jeżeli istnieje, najpierw ustal jego właściciela i stan; niczego nie nadpisuj.
Własny lokalny checkout/repo i gałąź `codex/studio-foundation` mają zawierać
świadomie wybrane pliki z manifestem ścieżek, hashami i wskazaniem pochodzenia.
Nie kopiuj `.env`, kluczy, sesji, `node_modules`, prywatnego Vaulta ani całych cache.
Zachowaj licencje. Niezbędne media benchmarku włączaj osobno z opisanym pochodzeniem.

Przed kopiowaniem i po nim porównaj hashe wybranych źródeł. Jeśli plik się zmienił,
ponów wyłącznie jego stabilny snapshot. Zamroź bazę i kontrakty przed fan-out.
Wykonawcy otrzymują osobne worktree z tej bazy, a nie z niepełnego HEAD źródła.
Nie używaj `git add -A`, nie stashuj i nie commituj cudzej bieżącej pracy.

## Właściciele i granice

Maksymalnie **czterech aktywnych wykonawców plus koordynator**, łącznie w całym
drzewie. Nie tworzyć kolejnych agentów tylko do przekazywania komunikatów.
Koordynator może dzielić przydziały niżej, ale musi przekazać wyłączną własność
plików, zachować globalny limit i zastępować zakończonych wykonawców.

| Właściciel | Zadania z TASKS | Pliki w docelowym `studio/` | Warunek odbioru |
|---|---|---|---|
| K — koordynator/integrator | T1, T2, później T8/T13/T14 | package/lock/tsconfig, `src/contracts/`, `src/formats/import.ts`, wspólne entrypointy, `src/api/`, minimalne `web/`, integracja, CI i instrukcje | Czysty build, kontrakt, stabilna baza; później połączone scenariusze i instalowalny wynik |
| A — format i kompilacja | T3 + wydzielenie kompozycji z T7 | `src/formats/` poza importerem K, `src/media/composition/`, `test/formats/` | Zapisany JSON steruje podglądem, zachowane ruch/napisy, nowa mowa wyznacza czas; bez cichego kopiowania treści referencji |
| B — wykonanie grafu | T5 → T6 → T4 → T11 | `src/storage/`, `src/orchestration/`, ich testy | Trwałe wykonanie, opcjonalne podgrafy, rewizje, cancel, kontrola kosztu i brak podwójnego submit |
| C — analiza i narzędzia | T7 → T12 | `src/providers/`, `src/media/` poza composition A, ich testy | Rzeczywista ekstrakcja i adaptery, izolowane źródła, koszt/status, cache; dostępność OpenShorts/video-use sprawdzona, nie założona |
| D — benchmark i evale | T10 → T9 | `eval/fixtures/`, `eval/manifests/`, `eval/acceptance/`, runner/scorers/report, `test/eval/` | Stały wzorzec, metryki, replay/live, wykrycie niepełnego swap; błędy i brak oceny nie przechodzą jako sukces |

Nie jesteście sami w kodzie. Nie cofajcie cudzych zmian. Potrzebną zmianę kontraktu,
lockfile lub wspólnego helpera zgłaszajcie K; jeden właściciel wprowadza zmianę
i ustala nową bazę. Zmianę granicy własności zapiszcie przed rozpoczęciem edycji.
Wykonawca D nie dostraja oczekiwanych odpowiedzi do wyniku A/C.

## Fale, które koordynator przechodzi sam

1. **Fundament:** K robi T1/T2 i próbę restartu LangGraph bez modeli. D równolegle
   porządkuje istniejące źródła i dowody benchmarku. Wynik: wspólny kontrakt,
   uruchamialny pakiet i zamrożone wejścia. Nie buduj rozbudowanego runtime przed
   potwierdzeniem instalowalności jego zależności.
2. **Cztery tory A–D:** praca w swoich modułach przeciw uzgodnionym portom.
   Integracja ma być częsta i mała. Stub pomaga tworzyć kod, ale nie kończy odbioru
   integracji. A/C nie czekają na gotowy UI. Live rusza dopiero po budżecie B.
3. **Pierwszy dowód:** K scala E0–E2 i E3, otrzymuje JSON, podglądy oraz raport
   per źródło/konfiguracja. Nie kończy zlecenia na tym kamieniu; przechodzi dalej.
4. **Prawdziwy montaż:** E4 podcast, następnie E5 Qwen/Julian/HeyGen. Dopiero tu
   minimalne API/UI do podania zadania, oglądania wyniku, akceptacji, korekty,
   stanu i anulowania. Można zlecić tę część zwolnionemu wykonawcy z nową własnością.
   UX z odłożonego mockupu nie jest wzorcem graficznym do implementacji.
5. **Niezależny odbiór:** zwolniony wykonawca sprawdza zintegrowaną wersję bez
   edytowania jej podczas pierwszego przeglądu. K usuwa wykazane błędy, ponawia
   właściwe testy i przygotowuje instalowalny artefakt oraz jeden raport końcowy.

Sekwencja B jest celowa: storage → rewizje → orkiestracja → limity. Testy i
kontrakty budżetu można przygotować wcześniej, ale płatne operacje czekają na
rzeczywiste egzekwowanie limitu. Pełne zależności T1–T14 pozostają w [TASKS](TASKS.md).

## Autonomia eksperymentów i proponowany budżet

**Zaakceptowane: 25 USD łącznie na dodatkowe koszty API całego zlecenia**, również
zużywane płatne kredyty, QA i retry; nie 25 USD na agenta/próbę. To propozycja
limitu, nie prognoza ceny ani gwarancja ukończenia E5 za tę kwotę.
Nie obejmuje rozliczenia sesji agentów programistycznych w koncie Codex/routera.
Alternatywa: wykonanie offline z limitem nowych kosztów API równym 0 USD.

Przed pierwszą płatną operacją K sprawdza dostęp, aktualne ceny i egzekwowalne
górne granice żądań, a następnie planuje koszt całego pozostałego odbioru.
Najpierw pomiary taniej analizy; zarezerwuj środki na E4/E5 zanim zaczniesz szerokie
porównania konfiguracji. Używaj istniejącego autoryzowanego dostępu; brak klucza
oznacza potrzebny dostęp, nie szukanie sekretów w innych projektach.
Bez zakupów subskrypcji, doładowań, publicznej publikacji i instalacji do żywego hosta.
Nie uznawaj nieznanej ceny za zero i nie rozsyłaj kopii kluczy do zleceń subagentów.

K dobiera niewielkie porównania konfiguracji z jedną zmienną naraz. Zmiana modelu
lub prompta wymaga nowego live wywołania; replay nie stanowi dowodu poprawy modelu.
Nie obiecujemy matematycznie najtańszej konfiguracji po kilku próbach: raport ma
pokazać najlepszy sprawdzony kompromis jakości i kosztu oraz zakres porównania.
Max 2 korekty QA po pierwszej próbie, max 20 zleceń poprawkowych na projekt;
globalny limit kosztu ma pierwszeństwo. Brak środków nie kasuje potrzebnych testów.

Testy bramek korzystają z jawnych fixture'ów i zdarzeń testowych. Koordynator może
wykonać techniczne próby scenariuszy po akceptacji tego zlecenia, ale nie zapisuje
fikcyjnej osobistej akceptacji filmu przez Jana ani nie publikuje wygenerowanego filmu.

## Definicja gotowej pracy

- Zaimplementowany lokalny pakiet TS i działający silnik; build/test/install
  niezależne od prywatnego Agent OS. macOS arm64 sprawdzony lokalnie; Linux x64
  sprawdzony w dostępnej izolacji/CI, a brak takiego środowiska jawnie zgłoszony.
- E0: walidacja i round-trip z ochroną danych; E1: rzeczywista ekstrakcja;
  E2: zapisany format odtwarzany podglądem; E3: właściwy plan, pomijanie zbędnej pracy.
- E4: realny podcast z cięciami, kadrowaniem i napisami; E5: prawdziwy MP4
  Qwen/Julian/HeyGen, z dowodami zgodności treści, czasu i kompozycji.
- Wymagane scenariusze [TEST-PLAN](TEST-PLAN.md) zaliczone, także restart,
  nieznany wynik dostawcy, spóźniony wynik, korekta napisów bez nowego głosu,
  reuse formatu i całkowity budżet. Designowe rozszerzenia pozostają odłożone.
- Raport pokazuje dokładną wersję kodu/modelu/prompta/narzędzi, wejścia, metryki,
  komendy, logi, koszty znane/nieznane, skipped i granice sprawdzenia. Bez
  `PASS` dla testów tylko na atrapach, bez obniżania progów po zobaczeniu wyniku.

`COMPLETE` wyłącznie po odbiorze całości. Jeśli brak dostępu/budżetu uniemożliwia
E1/E4/E5 albo brakuje środowiska odbioru, wynik to `PARTIAL_NEEDS_INPUT`, z kodem,
zaliczonymi testami i dokładną pozostałą operacją. Nie wracaj z samym problemem,
jeśli nadal można wykonać niezależną część zlecenia. Błąd implementacyjny jest
zadaniem K i zespołu; nie powodem przekazania naprawy rootowi.

## Komunikacja i wynik przekazania

K prowadzi lokalnie `docs/video-formats/EXECUTION-LOG.md` (kamienie i decyzje) oraz
`DELIVERY-REPORT.md` (stan całości). Raport końcowy: co działa, artefakty/ścieżki,
commit lub patch, polecenie odtworzenia, wyniki E0–E5, koszt i pozostające ograniczenia.
Raporty wykonawców trafiają do K. Root dostaje zakończenie, istotny nierozwiązywalny
problem albo zwięzłą odpowiedź na jawne pytanie o stan; nie raport każdej poprawki.
Po zakończeniu każdego potomka wywołaj `interrupt_agent`; zakończonego potomka
nie zostawiaj w stanie roboczym. W razie urwanego finalu sprawdź pliki/testy i zleć
dokończenie, zamiast uznawać samo zakończenie sesji za ukończenie zadania.

Gotowa treść uruchomienia: [COORDINATOR-PROMPT.md](COORDINATOR-PROMPT.md).
