# Zlecenie C — pamięć i integracja Agent OS

Status: gotowe do przydzielenia, **nieuruchomione**. Zakres: T4, T6.
Punkt startu: T4 przeciw uzgodnionemu portowi po T0; realny odbiór z T2. T6 po T3/T4/T5.

## Instrukcja dla wykonawcy

Pracujesz nad zatwierdzonym OmniWatchem w repo video-watch. Czytaj
[TECHNICAL](../TECHNICAL.md), [TASKS](../TASKS.md), [TEST-PLAN](../TEST-PLAN.md) i
[zasady koordynacji](README.md). Wykonaj wyłącznie poniższy zakres.

Najpierw indywidualne notatki w skonfigurowanym Vaultcie, idempotentny zapis,
odczyt, jawne wyszukiwanie i odpowiedzi z referencjami. Nie wymagaj prywatnego układu
Vaulta ani heurystyki językowej Apollo. Następnie podłącz istniejące UI/API: summary
domyślne, teardown, focus i dalsza rozmowa. Hermes używa CLI D i kolekcji, nie własnego
silnika; trwały raport odbierz także po timeoutcie. Astros pozostaje linkiem.
Nie dotykaj implementacji silnika A ani instalatora/rejestratora F.

Nie pracujesz sam w repozytorium. Nie cofaj cudzych zmian i nie nadpisuj ich.
Zachowaj legacy dispatch endpointu jobs dla both/blueprint/screentext/sourceId
na bazie adaptera A, wraz z odczytem statusu tych zadań.
Nie edytuj plików innych właścicieli, root locka ani contracts bez koordynatora.
Dostosuj implementację do odebranych zmian innych wykonawców. Nie uruchamiaj nowych
agentów ani nie publikuj zmian. Nie zaczynaj zależnej integracji przed odbiorem jej kontraktu.

## Własność plików

- `agent-os-module/src/lib/omniwatchMemory.ts`
- `agent-os-module/src/lib/omniwatchHost.ts`
- `test/e2e/vault.spec.ts`
- `agent-os-module/src/components/OmniWatchView.tsx`
- `agent-os-module/src/components/ChannelScan.tsx`
- `agent-os-module/src/components/ScoutView.tsx`
- `agent-os-module/src/app/api/omniwatch/jobs/`
- `agent-os-module/src/app/api/omniwatch/channel/`
- `agent-os-module/src/app/api/omniwatch/scout/`
- `agent-os-module/src/lib/omniwatchJobs.ts`
- `agent-os-module/hermes/omniwatch-scout.py`
- `test/e2e/single-video.spec.ts`
- `test/e2e/channel.spec.ts`
- `test/e2e/lifecycle.spec.ts`
- `agent-os-module/src/app/api/omniwatch/status/`
- `agent-os-module/src/app/api/omniwatch/media/`
- `agent-os-module/src/app/api/omniwatch/i18n/`
- `agent-os-module/test/card-source.test.mjs`

Wspólne katalogi mogą zawierać pliki innych wykonawców: własność obejmuje tylko
wymienione moduły i nazwane testy. Nowy wspólny helper zgłoś koordynatorowi.

## Odbiór

T08/T09/T10/T12/T14/T15, test card-source, A10 na czystym hoście. Błąd pamięci widoczny; nowy cron nie dubluje istniejącego.

Testy dołączaj do każdej funkcji. Oddziel test ze stubem od realnej integracji;
nie twierdź, że wdrożenie przeszło na podstawie samego typecheck.

## Przekazanie

Dostarcz F listę plików/integracji hosta i wymaganych capability checks; raportuj dokładnie czystą wersję hosta oraz co pozostaje stubowane.

Na końcu podaj pliki, zakres diffu/commit, komendy i wyniki testów, kontrakty przekazane
innym oraz jawne blokady. Nie oznaczaj pracy gotowej, jeśli zależny komponent nadal
jest tylko stubem. Brak dostępu do płatnego modelu nie uzasadnia uruchomienia innego
providera ani pominięcia opisu brakującego odbioru.
