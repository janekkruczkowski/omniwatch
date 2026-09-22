# Zlecenie F — paczka i instalator

Status: gotowe do przydzielenia, **nieuruchomione**. Zakres: T8.
Punkt startu: Przygotowanie procesu po T0; pełny odbiór wymaga T6+T7.

## Instrukcja dla wykonawcy

Pracujesz nad zatwierdzonym OmniWatchem w repo video-watch. Czytaj
[TECHNICAL](../TECHNICAL.md), [TASKS](../TASKS.md), [TEST-PLAN](../TEST-PLAN.md) i
[zasady koordynacji](README.md). Wykonaj wyłącznie poniższy zakres.

Buduj raz jeden tarball ESM i testuj dokładnie ten artefakt w obu powłokach.
Manifest/Node/zgodność schematu/checksum, preflight przed zmianami, backup i rollback,
ochrona zmienionych plików gospodarza. Bez kopiowania całego src/lib, usuwania wszystkich
routeów OmniWatcha i uruchamiania patcherów Directora. Root package/lock zmienia tylko
koordynator. Testuj przerwanie instalacji, aktywny worker, wstrzymany stary snapshot
oraz niezgodne nowe wydanie. Nie publikuj ani nie instaluj do prywatnego hosta autora.

Nie pracujesz sam w repozytorium. Nie cofaj cudzych zmian i nie nadpisuj ich.
Nie edytuj plików innych właścicieli, root locka ani contracts bez koordynatora.
Dostosuj implementację do odebranych zmian innych wykonawców. Nie uruchamiaj nowych
agentów ani nie publikuj zmian. Nie zaczynaj zależnej integracji przed odbiorem jej kontraktu.

## Własność plików

- `scripts/release/`
- `agent-os-module/install.sh`
- `agent-os-module/register-nav.py`
- `docs/omniwatch/install/`
- `test/install/release.test.mjs`
- `.github/workflows/omniwatch.yml`

Wspólne katalogi mogą zawierać pliki innych wykonawców: własność obejmuje tylko
wymienione moduły i nazwane testy. Nowy wspólny helper zgłoś koordynatorowi.

## Odbiór

T16: macOS/Windows oraz Linux dla Agent OS; brak sekretów w paczce, clean install obu aplikacji, update beta, rollback.

Testy dołączaj do każdej funkcji. Oddziel test ze stubem od realnej integracji;
nie twierdź, że wdrożenie przeszło na podstawie samego typecheck.

## Przekazanie

Koordynator otrzymuje artefakt, manifest, hash, wyniki macierzy instalacji i ograniczenia; dopiero potem T9/pilotaż.

Na końcu podaj pliki, zakres diffu/commit, komendy i wyniki testów, kontrakty przekazane
innym oraz jawne blokady. Nie oznaczaj pracy gotowej, jeśli zależny komponent nadal
jest tylko stubem. Brak dostępu do płatnego modelu nie uzasadnia uruchomienia innego
providera ani pominięcia opisu brakującego odbioru.
