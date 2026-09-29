# OmniWatch — zatwierdzone zadania wykonawcze

Ukończono dwa audyty przygotowawcze T0; implementacja T1–T9 jeszcze nie ruszyła.
[Zlecenia A–F i fale pracy](work-orders/README.md) przypisują zakresy wykonawcom.
Role W0–W6 oznaczają własność pracy, nie przypisane osoby.
Zadania wynikają z ustaleń R1–R8 w [projekcie technicznym](TECHNICAL.md), testy T01–T18
z [planu testów](TEST-PLAN.md). D1–D11 zostały zaakceptowane przez użytkownika.

Estymaty porównawcze S/M/L dotyczą nakładu zespołu i pracy z agentem, nie kalendarza
ani obietnicy terminu. Pilotaż i zewnętrzne ograniczenia platform mogą dominować czas.
Testy modułu powstają razem z nim; T9 nie jest odłożeniem testów na koniec.

## Implementation Tasks

- [ ] **T0 (P1, W0, zespół: M / z agentem: S–M) — Zamrozić kontrakty i dane odbioru**
  - Źródło: R1/R6: dwa silniki i zależność testów od prywatnej instalacji.
  - Zależności: brak; pierwszy krok.
  - Własność: `docs/omniwatch/`, `package.json`, `package-lock.json`, `tsconfig.json`, `packages/omniwatch/src/contracts/`, `test/fixtures/`.
  - Rezultat: Fixture bety, mapa konsumentów omniwatch.ts/Jobs, kontrakty API i katalogu danych; własne narzędzia build/test; wskazany czysty host do odbioru.
  - Odbiór: build/typecheck fixture kontraktów; testy nie czytają prywatnego Vaulta i nie wymagają klucza.

- [ ] **T1 (P1, W1, zespół: L / z agentem: M) — Wydzielić analizę i źródła ze wspólnym kontekstem rozmowy**
  - Źródło: R1/R4/R5: coupling, retry i brak historii modelu.
  - Zależności: T0.
  - Własność: `packages/omniwatch/src/analysis/`, `packages/omniwatch/src/sources/`, `agent-os-module/src/lib/omniwatch.ts`, `agent-os-module/src/lib/omniwatchI18n.ts`, `agent-os-module/src/lib/omniwatchPresets.ts`, `agent-os-module/src/lib/omniwatchChannel.ts`, `agent-os-module/src/lib/omniwatchX.ts`, `agent-os-module/src/lib/omniwatchAds.ts`, `agent-os-module/src/lib/omniwatchScout.ts`, `agent-os-module/src/lib/apify.ts`, `agent-os-module/test/duration.test.mjs`, `packages/omniwatch/test/analysis-contract.test.mjs`, `packages/omniwatch/test/sources.test.mjs`, `packages/omniwatch/test/provider.test.mjs`, `packages/omniwatch/test/conversation.test.mjs`.
  - Rezultat: Jeden silnik summary/teardown, focus, jawna historia i provider attempts; stare importy TS jako adaptery; bez usuwania funkcji drugiego projektu.
  - Odbiór: T02/T05/T06/T10; runtime bez Next/Hermesa/Vaulta; test starych konsumentów.

- [ ] **T2 (P1, W2, zespół: L / z agentem: M) — Dodać trwały stan i odzyskiwanie pracy**
  - Źródło: R2/R4: RAM i niepewny zapis wyników.
  - Zależności: T0.
  - Własność: `packages/omniwatch/src/storage/`, `packages/omniwatch/test/operations.test.mjs`, `packages/omniwatch/test/recovery.test.mjs`, `packages/omniwatch/test/delivery.test.mjs`.
  - Rezultat: SQLite, schema migrations, unique keys, attempts i bufor; błąd zapisu blokuje wydatki; recovery bez automatycznego powtarzania niepewnego wywołania.
  - Odbiór: T03/T07/T08 z realnym SQLite i fault injection; dwuprocesowa deduplikacja.

- [ ] **T3 (P1, W3, zespół: M–L / z agentem: M) — Uruchamiać wspólną kolejkę niezależnie od panelu**
  - Źródło: R2: brak właściciela i cyklu życia wykonania.
  - Zależności: T1, T2.
  - Własność: `packages/omniwatch/src/runtime/`, `packages/omniwatch/test/runtime.test.mjs`, `packages/omniwatch/test/input.test.mjs`.
  - Rezultat: CLI, process ownership, enqueue/exit, pauza/cancel, sekret tylko z adaptera konfiguracji; testowalny zegar i limity.
  - Odbiór: T01/T04/T14: zamknięcie rodzica, stary token, błędny start, wznowienie.

- [ ] **T4 (P1, W4, zespół: M–L / z agentem: M) — Podłączyć zapis, wyszukiwanie i pytania do Vaulta**
  - Źródło: R3: brak odbioru biblioteki w stockowym hoście.
  - Zależności: T0, T2.
  - Własność: `agent-os-module/src/lib/omniwatchMemory.ts`, `agent-os-module/src/lib/omniwatchHost.ts`, `test/e2e/vault.spec.ts`.
  - Rezultat: Indywidualne notatki i referencje, idempotentny zapis, konflikty bez nadpisania; jawny retrieval i klient modelu gospodarza; brak prywatnych heurystyk wymaganych od użytkownika.
  - Odbiór: T08/T15 i A10 na wskazanej czystej instalacji; E05 w T9.

- [ ] **T5 (P1, W3, zespół: M–L / z agentem: M) — Ujednolicić pełny skan i aktualizacje Scouta**
  - Źródło: R7/R8: wielkość archiwum, koszty i różne limity źródeł.
  - Zależności: T3.
  - Własność: `packages/omniwatch/src/collections/`, `packages/omniwatch/test/listing.test.mjs`, `packages/omniwatch/test/scan.test.mjs`, `packages/omniwatch/test/performance.test.mjs`.
  - Rezultat: Trwała enumeracja, snapshots, źródłowe capabilities, nowe ID, budżet, brak przymusowego rankingu; strony zamiast pełnych tekstów wszystkich filmów.
  - Odbiór: T11/T12/T13/T18: 1201+ filmów, 0/2 nowe, częściowe źródło, 10k metadanych.

- [ ] **T6 (P1, W4, zespół: L / z agentem: M) — Podłączyć Agent OS, UI i harmonogram Hermesa**
  - Źródło: R2/R3/R5/R8: końcowy przepływ produktu.
  - Zależności: T3, T4, T5.
  - Własność: `agent-os-module/src/components/OmniWatchView.tsx`, `agent-os-module/src/components/ChannelScan.tsx`, `agent-os-module/src/components/ScoutView.tsx`, `agent-os-module/src/app/api/omniwatch/jobs/`, `agent-os-module/src/app/api/omniwatch/channel/`, `agent-os-module/src/app/api/omniwatch/scout/`, `agent-os-module/src/lib/omniwatchJobs.ts`, `agent-os-module/src/app/api/omniwatch/status/`, `agent-os-module/src/app/api/omniwatch/media/`, `agent-os-module/src/app/api/omniwatch/i18n/`, `agent-os-module/test/card-source.test.mjs`, `agent-os-module/hermes/omniwatch-scout.py`, `test/e2e/single-video.spec.ts`, `test/e2e/channel.spec.ts`, `test/e2e/lifecycle.spec.ts`.
  - Rezultat: Default summary, focus/teardown i kontekst kart; trwały status/odczyt; cron wskazuje kolekcję i wspólne CLI; zero nowych = cisza; trwały raport, odbiór po timeoutcie i ponowienie bez analizy; nie usuwać routeów produkcji filmów.
  - Odbiór: A0–A10/A13–A15 offline; test card-source i poprawność linku Astrosa.

- [ ] **T7 (P1, W6, zespół: L / z agentem: M) — Zmigrować wydany standalone bez utraty danych**
  - Źródło: R1/R5: zgodność istniejącej bety.
  - Zależności: T1, T2, T3.
  - Własność: `apps/standalone/`, `app.py`, `omniwatch.py`, `static/`, `test/install/python-beta.test.mjs`.
  - Rezultat: Adapter HTTP/SSE, lokalna konfiguracja i zapis; legacy ID/metadata/cache; stare launchery i port; własny runtime bez hosta.
  - Odbiór: T17, A9/A11/A13–A15; sumy kontrolne, zero model calls podczas migracji, powrót do bety.

- [ ] **T8 (P1, W5, zespół: M–L / z agentem: M) — Złożyć wydanie i bezpieczny instalator**
  - Źródło: R1/R6: jedna paczka i powtarzalny odbiór poza maszyną autora.
  - Zależności: T6, T7.
  - Własność: `scripts/release/`, `agent-os-module/install.sh`, `agent-os-module/register-nav.py`, `docs/omniwatch/install/`, `test/install/release.test.mjs`, `.github/workflows/omniwatch.yml`.
  - Rezultat: Build once, lokalny tarball, manifest/checksum, preflight/backup/rollback, ochrona zmian hosta i snapshotów wstrzymanych operacji, brak patcherów Directora; CI instalacji. Projekt skryptów można zacząć po T0, pełny odbiór dopiero po T6/T7.
  - Odbiór: T16 na macOS/Windows i Linux dla hosta; dokładne Node/narzędzia w manifeście; test braku sekretów/fixture prywatnych w paczce.

- [ ] **T9 (P1, W0, zespół: M / z agentem: S–M) — Odebrać produkt na próbkach i w pilotażu**
  - Źródło: R6: brak dowodu jakości i samodzielnej instalacji.
  - Zależności: T8.
  - Własność: `test/eval/omniwatch/`, `docs/omniwatch/release-evidence/`, `docs/omniwatch/TEST-PLAN.md`.
  - Rezultat: Mały E01–E05, dostępność platform, wyniki instalacji/migracji i pilotaż społeczności; oddzielić błędy modułu od odłożonego projektu produkcji filmów.
  - Odbiór: Wszystkie właściwe A0–A15 poza chmurą A12; raport wersji, próbek, kosztu, ograniczeń i odbioru przez użytkownika.

## Zależności i równoległość

| Strumień | Moduły | Zależności |
|---|---|---|
| Fundament T0 | contracts, root tooling, fixtures | Plan zaakceptowany; T0 do wykonania |
| A: T1 | analysis, sources, legacy libs | T0 |
| B: T2 | storage | T0 |
| C: T3 → T5 | runtime, collections | T1+T2; kolejno |
| D: T4 → T6 | adapter pamięci → UI/API/Hermes | T4 po T2; T6 także po T5 |
| E: T7 | apps/standalone, stare launchery/static | T3 |
| F: T8 → T9 | release/installer/CI → odbiór | T6+T7 |

Kolejność: T0 → A+B równolegle → C+D równolegle (T4) → po T3 także E.
T6 czeka na T4 i T5. Integrator scala przed wspólnym testem, potem F.
Przygotowanie pakowania przez W5 może ruszyć po T0, ale nie deklaruje odbioru przed T6/T7.

Konflikty: kontrakty i root package/lock ma wyłącznie W0; W1 jest jedynym autorem zmian
w starym silniku/source libs podczas ekstrakcji. W3 korzysta z jego adapterów, nie dopisuje
własnego listowania do tych plików. `omniwatchJobs.ts` przejmuje W4 po zinwentaryzowaniu
konsumentów w T0. Instalator i rejestrator nawigacji należą do W5. W4 i W6 nie poprawiają
wspólnego silnika przy okazji integracji — zgłaszają potrzebną zmianę właścicielowi W1.

Przed uruchomieniem osobnych worktree integrator tworzy uzgodniony punkt bazowy z
potrzebnymi dokumentami i istniejącym kodem: obecna gałąź ma niezacommitowaną pracę.
Nowy worktree jej automatycznie nie dziedziczy. Nie używać `git add -A`; nie zabierać
ani nie cofać pracy drugiego projektu. Każde zlecenie zawiera pliki, zależności,
kontrakt odbioru oraz zakaz nadpisywania zmian innych wykonawców.

## Pierwszy konkretny odcinek

Zaczynamy od **T0, równoległych T1/T2 i T3**, kończąc demonstracją
przepływu jednego filmu w minimalnym CLI/harnessie integracyjnym:
summary → focus → teardown → doprecyzowanie, z trwałym wynikiem po restarcie.
To bramka wewnętrzna, nie pomniejszone wydanie społecznościowe. Następnie skany,
Vault i Hermes; standalone można integrować równolegle po ustabilizowaniu runtime.
Wydanie dla społeczności pozostaje pierwszym priorytetem publikacji.

## Poza bieżącym backlogiem

Produkcja filmów, płatna chmura, konta/rozliczenia, ZIP/wiki tematyczne, vector DB,
rozproszona kolejka, automatyczna obsługa prywatnych materiałów i pełne archiwa platform
bez odpowiedniego adaptera. Powody i granice są w PLAN/SPEC; nie tworzymy teraz
niezależnych zadań implementacyjnych dla tych pomysłów.
