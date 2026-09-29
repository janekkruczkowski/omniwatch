# Zlecenie D — wykonanie i skany

Status: gotowe do przydzielenia, **nieuruchomione**. Zakres: T3, T5.
Punkt startu: Przygotuj testy po T0; runtime integruj po T1+T2. T5 wykonaj po odbiorze T3.

## Instrukcja dla wykonawcy

Pracujesz nad zatwierdzonym OmniWatchem w repo video-watch. Czytaj
[TECHNICAL](../TECHNICAL.md), [TASKS](../TASKS.md), [TEST-PLAN](../TEST-PLAN.md) i
[zasady koordynacji](README.md). Wykonaj wyłącznie poniższy zakres.

Jeden proces roboczy na dataDir, start na żądanie, potwierdzenie gotowości,
przejęcie pracy, heartbeat/token, enqueue kontra exit, pause/cancel i wznowienie.
Następnie wspólna enumeracja i snapshot skanu: all partiami, partial/failed odróżnione
od pustego wyniku, stabilne ID, 0/2 nowe, limity i źródłowe capabilities. Nie dodawaj
własnych promptów Scouta. Dostarcz trwały raport per przebieg do adaptera C.
Nie edytuj starych source libs A ani schematu B poza uzgodnionym przekazaniem.

Nie pracujesz sam w repozytorium. Nie cofaj cudzych zmian i nie nadpisuj ich.
Nie edytuj plików innych właścicieli, root locka ani contracts bez koordynatora.
Dostosuj implementację do odebranych zmian innych wykonawców. Nie uruchamiaj nowych
agentów ani nie publikuj zmian. Nie zaczynaj zależnej integracji przed odbiorem jej kontraktu.

## Własność plików

- `packages/omniwatch/src/runtime/`
- `packages/omniwatch/test/runtime.test.mjs`
- `packages/omniwatch/test/input.test.mjs`
- `packages/omniwatch/src/collections/`
- `packages/omniwatch/test/listing.test.mjs`
- `packages/omniwatch/test/scan.test.mjs`
- `packages/omniwatch/test/performance.test.mjs`

Wspólne katalogi mogą zawierać pliki innych wykonawców: własność obejmuje tylko
wymienione moduły i nazwane testy. Nowy wspólny helper zgłoś koordynatorowi.

## Odbiór

T01/T04/T11/T13/T14/T18; realne procesy, 1201 filmów, 10k metadanych, końcowy raport po timeoutcie bez nowych model calls.

Testy dołączaj do każdej funkcji. Oddziel test ze stubem od realnej integracji;
nie twierdź, że wdrożenie przeszło na podstawie samego typecheck.

## Przekazanie

C otrzymuje wersjonowany protokół CLI/jobs/progress/reports, E tę samą analizę przez runtime, F wymagania procesu przy aktualizacji.

Na końcu podaj pliki, zakres diffu/commit, komendy i wyniki testów, kontrakty przekazane
innym oraz jawne blokady. Nie oznaczaj pracy gotowej, jeśli zależny komponent nadal
jest tylko stubem. Brak dostępu do płatnego modelu nie uzasadnia uruchomienia innego
providera ani pominięcia opisu brakującego odbioru.
