# Zlecenie A — silnik i źródła

Status: gotowe do przydzielenia, **nieuruchomione**. Zakres: T1.
Punkt startu: Po zatwierdzeniu kontraktów i bramki T0.

## Instrukcja dla wykonawcy

Pracujesz nad zatwierdzonym OmniWatchem w repo video-watch. Czytaj
[TECHNICAL](../TECHNICAL.md), [TASKS](../TASKS.md), [TEST-PLAN](../TEST-PLAN.md) i
[zasady koordynacji](README.md). Wykonaj wyłącznie poniższy zakres.

Wydziel istniejący TS, nie przepisuj silnika od zera. Zachowaj summary/teardown,
focus, question, języki, cache, podział i obsługę platform. Dodaj poprawny kontekst
parentTurnId. Oddziel transport modelu i zdarzenia próby od orkiestracji SQLite.
Odczytaj DEPENDENCIES.md; pozostaw cienkie zgodne eksporty dla konsumentów filmowych.
Przerwane płatne wywołanie ma wynik nieznany, a nie automatyczny retry.

Nie pracujesz sam w repozytorium. Nie cofaj cudzych zmian i nie nadpisuj ich.
Zachowaj legacy entrypoint dla both/blueprint/screentext/sourceId; core nie importuje
promptów produkcji. C mapuje dotychczasowy endpoint do tego adaptera.
Nie edytuj plików innych właścicieli, root locka ani contracts bez koordynatora.
Dostosuj implementację do odebranych zmian innych wykonawców. Nie uruchamiaj nowych
agentów ani nie publikuj zmian. Nie zaczynaj zależnej integracji przed odbiorem jej kontraktu.

## Własność plików

- `packages/omniwatch/src/analysis/`
- `packages/omniwatch/src/sources/`
- `agent-os-module/src/lib/omniwatch.ts`
- `agent-os-module/src/lib/omniwatchI18n.ts`
- `agent-os-module/src/lib/omniwatchPresets.ts`
- `agent-os-module/src/lib/omniwatchChannel.ts`
- `agent-os-module/src/lib/omniwatchX.ts`
- `agent-os-module/src/lib/omniwatchAds.ts`
- `agent-os-module/src/lib/omniwatchScout.ts`
- `packages/omniwatch/test/analysis-contract.test.mjs`
- `packages/omniwatch/test/sources.test.mjs`
- `packages/omniwatch/test/provider.test.mjs`
- `packages/omniwatch/test/conversation.test.mjs`
- `agent-os-module/src/lib/apify.ts`
- `agent-os-module/test/duration.test.mjs`

Wspólne katalogi mogą zawierać pliki innych wykonawców: własność obejmuje tylko
wymienione moduły i nazwane testy. Nowy wspólny helper zgłoś koordynatorowi.

## Odbiór

T02/T05/T06/T10; test starych eksportów i karty A→B. Import rdzenia działa bez Next, Hermesa i Vaulta.

Testy dołączaj do każdej funkcji. Oddziel test ze stubem od realnej integracji;
nie twierdź, że wdrożenie przeszło na podstawie samego typecheck.

## Przekazanie

Dostarcz B/D kontrakt zdarzeń próby i result; C/E publiczne wejście analizy oraz zgodne mapowanie legacy q.

Na końcu podaj pliki, zakres diffu/commit, komendy i wyniki testów, kontrakty przekazane
innym oraz jawne blokady. Nie oznaczaj pracy gotowej, jeśli zależny komponent nadal
jest tylko stubem. Brak dostępu do płatnego modelu nie uzasadnia uruchomienia innego
providera ani pominięcia opisu brakującego odbioru.
