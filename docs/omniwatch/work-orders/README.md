# OmniWatch — podział pracy po akceptacji planu

2026-09-22. Użytkownik zaakceptował plan D1–D11 i polecił rozdzielić pracę możliwie
równolegle. Ten dokument jest instrukcją przydziału, nie raportem wykonania funkcji.
Ukończono dwa audyty przygotowawcze T0: zależności obecnego kodu i kontrakty bety.
Żadne zadanie implementacyjne T1–T9 nie jest jeszcze oznaczone jako uruchomione.

Źródła: [TASKS](../TASKS.md), [TECHNICAL](../TECHNICAL.md), [TEST-PLAN](../TEST-PLAN.md).
Właściciel integracji: koordynator prowadzący obecne zadanie. Wykonawcy A–F poniżej
oznaczają osobne przydziały pracy; nie są nowymi zadaniami utworzonymi w pasku aplikacji.

## Przydziały i liczba równoległych wykonawców

| Wykonawca | Przydział | Może zacząć | Pełny odbiór wymaga |
|---|---|---|---|
| Koordynator | T0: kontrakty, narzędzia, punkt bazowy; później T9 | Teraz | Obu audytów T0 i przechodzącego testu kontraktów |
| A — silnik | [T1: analiza i źródła](A-ENGINE.md) | Po T0 | Zachowania obu trybów/rozmowy i zgodności starych konsumentów |
| B — stan | [T2: SQLite i odzyskiwanie](B-STORAGE.md) | Po T0, równolegle z A | Dwóch procesów, awarii i poprawnego bufora |
| C — Agent OS | [T4, potem T6: Vault, UI, Hermes](C-AGENT-OS.md) | T4 po kontraktach T0 przeciw stubowi zapisu | T4 z realnym T2; T6 także T3 i T5 |
| D — wykonanie | [T3, potem T5: runtime i skany](D-RUNTIME-SCANS.md) | Projekt testów po T0; integracja runtime po T1+T2 | Najpierw T3, potem T5 |
| E — standalone | [T7: migracja bety](E-STANDALONE.md) | Fixture'y bety niezależnie; adapter przeciw stubowi po T0 | T1+T2+T3 |
| F — wydanie | [T8: paczka i instalator](F-RELEASE.md) | Przygotowanie procesu po T0 | T6+T7 przed pełnym odbiorem |

**Limit organizacyjny: 3–4 aktywnych wykonawców plus koordynator**, nie sześć naraz.
Liczba sześciu przydziałów opisuje odpowiedzialność, nie wymóg sześciu równoległych sesji.
Wcześniejsze przygotowanie przy użyciu stubów nie zwalnia zależności odbioru z TASKS.
Nie wolno oznaczyć integracji jako gotowej na podstawie samych stubów.

## Fale pracy

```text
PRZYGOTOWANIE
  koordynator: kontrakty + build/test
  audyt zależności TS  -------------------+
  audyt/fixture'y bety -------------------+--> bramka T0

FALA 1 — po T0, do czterech wykonawców
  A: T1 silnik --------------------------+
  B: T2 SQLite --------------------------+--> D: T3 runtime
  C: T4 Vault (stub -> realny T2) ---------+                |
  F: T8 przygotowanie paczki/instalatora                    |
                                                          v
FALA 2 — po T3, trzy niezależne obszary
  D: T5 skany ---------------------------+
  C: kończy T4 / przygotowuje T6 UI -------+--> C: integracja T6
  E: T7 standalone ---------------------------------------+
                                                          |
FALA 3                                                  T6 + T7
  F: pełny odbiór T8 <-------------------------------------+
  koordynator: T9 próbki / pilotaż
```

T4 nie czeka na całe T1, a przygotowanie instalatora nie czeka bezczynnie na oba UI.
Migracja standalone może powstawać równolegle ze skanami i integracją Agent OS.
Nie równoleglimy T3 z nieustalonym kontraktem bazy ani T6 z nieustalonym wynikiem skanu.
Nie dzielimy edycji starego `omniwatch.ts` między kilku wykonawców.

## Bramka T0 — warunek startu pierwszej fali

- Kontrakty w `packages/omniwatch/src/contracts/`: request/source/result, focus/question,
  conversation/parent, run/item/attempt, store/delivery/host adapters, błędy i wersje.
- Uzgodniony kierunek wywołań: runtime orkiestruje core i store; core nie wywołuje
  SQLite/Vaulta. Próby modelu publikują zdarzenia przed i po wykonaniu według D3.
- Root build/test i manifest jednej biblioteki działają na syntetycznym przykładzie,
  bez korzystania z prywatnego `node_modules` Agent OS.
- [Mapa zależności](DEPENDENCIES.md) rozdziela konsumentów analizy i produkcji;
  wskazuje eksporty, których ekstrakcja nie może zerwać.
- [Kontrakty bety i fixture'y](BETA-FIXTURES.md) mają jednoznaczne wejścia/wyjścia;
  minimalne syntetyczne dane do testu migracji są przygotowane bez prywatnych treści.
- Zapisana wersja kontraktów oraz wspólny punkt bazowy dla wykonawców. Samo napisanie
  tych dokumentów nie kończy T0 — potrzebne są kontrakty i ich działający test.

## Pliki wspólne i reguły integracji

- Koordynator: root `package.json`, lock, `tsconfig`, package manifest/exports biblioteki,
  `contracts/`, wspólne fixture'y oraz główne dokumenty produktu. Wykonawcy zgłaszają
  potrzebną zależność/import; nie edytują wspólnie locka ani kontraktów.
- A: stare pliki silnika i providerów wskazane w T1. C/D/E używają ich kontraktów;
  nie poprawiają ich równolegle. A zostawia działające adaptery dla drugiego projektu.
- B: `storage/`; D: `runtime/` i `collections/`. D nie dodaje tabel poza uzgodnionym store.
- C: adaptery hosta, wybrane UI/API, `omniwatchJobs.ts` oraz launcher/schedule Hermesa.
  F: instalator i rejestrator nawigacji. Zmiana wejścia CLI Hermesa uzgodniona z D;
  jeden autor pliku launchera, nie równoległe implementacje C i F.
- E: `apps/standalone`, `app.py`, `omniwatch.py`, `static/`; F nie zmienia launcherów
  przy okazji pakowania. E nie zmienia core dla obejścia brakującej funkcji.
- Każdy wykonawca ma własne nazwane testy z TASKS; wspólne test helpers i fixture'y
  aktualizuje koordynator na wniosek. Przesunięcie własności pliku zapisujemy przed edycją.

## Rozstrzygnięcia audytów do przekazania

- A otrzymuje także `apify.ts` i `duration.test.mjs`; C route’y status/media/i18n
  i `card-source.test.mjs`. Przydziały zapisano w TASKS/JSONL i zleceniach.
- C zachowuje obsługę legacy `both/blueprint/screentext/sourceId` w dotychczasowym
  endpointcie jobs przez jawny dispatch do adaptera. Nowa publiczna analiza ma
  summary/teardown; odłożenie produkcji nie oznacza usunięcia jej istniejącego wejścia.
  A dostarcza zgodny legacy entrypoint; C nie przenosi promptów produkcji do core.
- T0 zamraża dotychczasowe wartości strip bety jako test zgodności adaptera; nie
  zmieniamy sposobu zaokrąglania przy okazji ekstrakcji. Nowa polityka sampling jest
  wersjonowana oddzielnie od tej zgodności.
- E dodaje do istniejącego frontendowego transportu conversation/parent ID, bo sam
  URL nie identyfikuje rozmowy. To dostosowanie obecnego interfejsu, bez redesignu.
- E obsługuje koszt nieznany jawnie w formatterze (bez `.toFixed` na null i bez zera
  udającego rachunek) oraz widoczny błąd brakującego klucza. T0 zachowuje goldeny
  znanego kosztu; nowe stany mają osobne przypadki kontraktowe.

## Workspace i przekazanie pracy

W repo są niezacommitowane zmiany drugiego projektu. Obecny HEAD nie jest pełnym
stanem roboczym. Sam `git worktree add HEAD` nie przeniesie potrzebnych dokumentów
ani niezacommitowanych zależności.

Przed implementacją koordynator wybiera potrzebne pliki i tworzy jawny punkt bazowy
na gałęzi `codex/omniwatch-foundation`; nie wykonuje `git add -A` i nie przepisuje historii.
Audyt wskazuje zależności, które trzeba uwzględnić lub odizolować adapterem. Jeżeli
wydzielenie bazy wymaga przejęcia cudzej bieżącej pracy, przygotowanie zatrzymuje się
na konkretnym konflikcie zamiast oznaczać tę pracę jako naszą. Gotowe dokumenty
przygotowawcze pozostają w obecnym katalogu do czasu ustalenia bazy.

Po T0 osobne worktree dla aktualnie aktywnych wykonawców, z gałęziami `codex/omniwatch-*`.
Koordynator scala tylko odebrane porcje i aktualizuje wspólną bazę przed następną falą.
Żaden wykonawca nie instaluje zmian do prywatnego działającego Agent OS.

Każdy raport przekazania zawiera: pliki, commit lub zakres diffu, wykonaną funkcję,
komendy testów i wynik, granice stubów, potrzebne zmiany kontraktu oraz pozostające
blokady. Brak live API key nie blokuje odbioru offline; nie udaje jednak zaliczonej
próby dostawcy. Publikacja i pilotaż następują dopiero po bramkach wydania.
