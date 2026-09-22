# Zlecenie B — SQLite i odzyskiwanie

Status: gotowe do przydzielenia, **nieuruchomione**. Zakres: T2.
Punkt startu: Po T0, niezależnie od A; model i dostarczenie zastąp kontrolowanymi adapterami.

## Instrukcja dla wykonawcy

Pracujesz nad zatwierdzonym OmniWatchem w repo video-watch. Czytaj
[TECHNICAL](../TECHNICAL.md), [TASKS](../TASKS.md), [TEST-PLAN](../TEST-PLAN.md) i
[zasady koordynacji](README.md). Wykonaj wyłącznie poniższy zakres.

Zaimplementuj lokalny store na node:sqlite, wersjonowanie schematu, unique keys,
operacje/pozycje/próby, bufor i referencje. Nie dodawaj biblioteki wiedzy do SQLite.
Wymuś warunkowe zmiany stanów i własność procesu. Awaria zapisu wstrzymuje nowe koszty;
nieznany wynik wywołania wymaga jawnego odzyskania. Błąd dostarczenia nie powtarza modelu.
Uwzględnij reports/snapshot wykonania z aktualnej TECHNICAL, nie tylko pierwotny szkic D3.

Nie pracujesz sam w repozytorium. Nie cofaj cudzych zmian i nie nadpisuj ich.
Nie edytuj plików innych właścicieli, root locka ani contracts bez koordynatora.
Dostosuj implementację do odebranych zmian innych wykonawców. Nie uruchamiaj nowych
agentów ani nie publikuj zmian. Nie zaczynaj zależnej integracji przed odbiorem jej kontraktu.

## Własność plików

- `packages/omniwatch/src/storage/`
- `packages/omniwatch/test/operations.test.mjs`
- `packages/omniwatch/test/recovery.test.mjs`
- `packages/omniwatch/test/delivery.test.mjs`

Wspólne katalogi mogą zawierać pliki innych wykonawców: własność obejmuje tylko
wymienione moduły i nazwane testy. Nowy wspólny helper zgłoś koordynatorowi.

## Odbiór

T03/T07/T08: realna baza, dwie konkurujące instancje, fault injection i powtórne dostarczenie. Nie tylko mock SQLite.

Testy dołączaj do każdej funkcji. Oddziel test ze stubem od realnej integracji;
nie twierdź, że wdrożenie przeszło na podstawie samego typecheck.

## Przekazanie

Dostarcz D store API i zasady właściciela, C adapter bufora/dostarczeń, F reguły snapshotu i zgodności schematu.

Na końcu podaj pliki, zakres diffu/commit, komendy i wyniki testów, kontrakty przekazane
innym oraz jawne blokady. Nie oznaczaj pracy gotowej, jeśli zależny komponent nadal
jest tylko stubem. Brak dostępu do płatnego modelu nie uzasadnia uruchomienia innego
providera ani pominięcia opisu brakującego odbioru.
