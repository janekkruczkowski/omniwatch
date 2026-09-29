# Zlecenie E — migracja bety Pythona

Status: gotowe do przydzielenia, **nieuruchomione**. Zakres: T7.
Punkt startu: Fixture’y zgodności mogą powstawać wcześniej; adapter ze stubem po T0; pełna migracja po T3.

## Instrukcja dla wykonawcy

Pracujesz nad zatwierdzonym OmniWatchem w repo video-watch. Czytaj
[TECHNICAL](../TECHNICAL.md), [TASKS](../TASKS.md), [TEST-PLAN](../TEST-PLAN.md) i
[zasady koordynacji](README.md). Wykonaj wyłącznie poniższy zakres.

Zachowaj istniejący frontend i interfejs użycia. Node uruchamia wspólną bibliotekę;
Python jest launcherem bez własnego silnika. Wdroż wymagania BETA-FIXTURES.md:
.env i jego pierwszeństwo, stare komendy, port, SSE, pliki wyników, legacy ID/cache.
Nie rozszerzaj standalone o kanały, bibliotekę ani harmonogram. Nie czytaj prywatnych
wyników użytkownika jako fixture; stosuj syntetyczne pliki o rzeczywistych formatach.
Nie modyfikuj kontraktów/core dla lokalnego obejścia problemu.

Nie pracujesz sam w repozytorium. Nie cofaj cudzych zmian i nie nadpisuj ich.
Dodaj minimalne pola conversation/parent do transportu; zachowaj golden strip bety.
Koszt nieznany wyświetl jawnie, nie jako zero; brak klucza jako czytelny błąd.
Nie edytuj plików innych właścicieli, root locka ani contracts bez koordynatora.
Dostosuj implementację do odebranych zmian innych wykonawców. Nie uruchamiaj nowych
agentów ani nie publikuj zmian. Nie zaczynaj zależnej integracji przed odbiorem jej kontraktu.

## Własność plików

- `apps/standalone/`
- `app.py`
- `omniwatch.py`
- `static/`
- `test/install/python-beta.test.mjs`

Wspólne katalogi mogą zawierać pliki innych wykonawców: własność obejmuje tylko
wymienione moduły i nazwane testy. Nowy wspólny helper zgłoś koordynatorowi.

## Odbiór

T17, A9/A11/A13–A15; SHA istniejących analiz identyczne przy migracji; zero model calls; powtórna migracja i rollback.

Testy dołączaj do każdej funkcji. Oddziel test ze stubem od realnej integracji;
nie twierdź, że wdrożenie przeszło na podstawie samego typecheck.

## Przekazanie

F otrzymuje dokładny start command, lokalizacje danych i manifest runtime; koordynator dowód działania poza hostem Agent OS.

Na końcu podaj pliki, zakres diffu/commit, komendy i wyniki testów, kontrakty przekazane
innym oraz jawne blokady. Nie oznaczaj pracy gotowej, jeśli zależny komponent nadal
jest tylko stubem. Brak dostępu do płatnego modelu nie uzasadnia uruchomienia innego
providera ani pominięcia opisu brakującego odbioru.
