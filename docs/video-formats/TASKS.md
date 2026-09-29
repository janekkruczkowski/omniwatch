# Zadania po przeglądzie inżynierskim — propozycja

Operacyjny podział na wykonawców, izolacja i warunki startu: [DELEGATION](DELEGATION.md).

2026-09-22. Plan zaakceptowany wraz z limitem API 25 USD: [ACCEPTANCE](ACCEPTANCE.md).
Wykonanie przejmuje autonomiczny koordynator. P1 oznacza warunek odpowiedniego odbioru; nie powód blokowania wszystkich
niezależnych prac. Szacunki są orientacyjne, bez wiarygodnej tabeli kompresji czasu
w repo. Czas agentów obejmuje aktywną pracę i weryfikację, nie oczekiwanie na dostawców.

**Kolejność po korekcie Jana:** silnik i evale przed docelowym UI.
[DESIGN-TASKS](DESIGN-TASKS.md) i [UX](UX.md) odkładamy; U1–U6 nie są aktywnym
backlogiem ani warunkiem rozpoczęcia silnika. T8 dostarcza później minimalną
obsługę rzeczywistego procesu; osobny projekt graficzny wróci po dowodzie działania.

Pierwszy odbiór obejmuje kontrakt i zapis/odczyt formatu (T2), wiarygodny benchmark
(T10/T9), ekstrakcję i tani podgląd (potrzebne części T7/T3), potem dobór oraz
pomijanie etapów (T4). E0–E3 uruchamiamy przez harness/CLI bez zależności od T8.
Runtime, rewizje i kontrola kosztu pozostają zależnościami odpowiednich operacji;
live nadal wymaga T11. Nie trzeba ukończyć całego T13, aby otrzymać pierwszy raport.
Pełny podcast E4 i Qwen/Julian E5 pozostają kolejnymi odbiorami.

## Implementation Tasks

- [ ] **T1 (P1, człowiek 1–2 dni / agent 3–6 h)** — pakiet — Przygotuj niezależny runtime i próbę LangGraph.
  - Surfaced by: D1, D5; ukryta zależność od Agent OS i brak uruchamiania grafu po awarii.
  - Files: `studio/package.json`, `studio/package-lock.json`, `studio/tsconfig.json`, `studio/src/entry.ts`, `studio/test/install/`.
  - Verify: build w czystym katalogu; SQLite/checkpointer na macOS arm64 i Linux x64; przerwanie i wznowienie małego grafu bez API modeli.
- [ ] **T2 (P1, człowiek 2–3 dni / agent 5–8 h)** — kontrakty — Zdefiniuj wspólny schema i adaptery istniejących formatów.
  - Surfaced by: D2; luźne typy, dwa formaty i zachowywanie starej treści przy brakach.
  - Files: `studio/src/contracts/`, `studio/src/formats/import.ts`, `studio/test/contracts/`.
  - Verify: G01/G02, stałe sloty chronione, recipe/ruch zachowane; migracja nie nadpisuje oryginału ani nie nadaje akceptacji.
- [ ] **T3 (P1, człowiek 2–4 dni / agent 6–12 h)** — czas — Kompiluj czas odcinka z mowy i fragmentów źródłowych.
  - Surfaced by: D3; obecny writer zachowuje sekundy referencji.
  - Files: `studio/src/formats/timing.ts`, `studio/src/formats/compile.ts`, `studio/test/formats/`.
  - Verify: G10 oraz zmienione długości mowy w rankingu/podcaście; brak kotwicy blokuje, a nie zgaduje.
- [ ] **T4 (P1, człowiek 2–3 dni / agent 5–10 h)** — orkiestracja — Dodaj koordynatora i opcjonalne podgrafy.
  - Surfaced by: D4; model musi dobierać pracę przez kontrakt, bez własnego silnika grafu.
  - Files: `studio/src/orchestration/{graph,registry,planner,validators,reducers}.ts`, `studio/test/orchestration/`.
  - Verify: G03/G07/E3, pominięcie zbędnych agentów, znane zdolności, kompletne zależności, niezależne stany i ograniczona korekta.
- [ ] **T5 (P1, człowiek 2–3 dni / agent 5–10 h)** — storage/runtime — Utrwal komendy i stan, uruchamiaj worker po restarcie.
  - Surfaced by: D5; checkpoint nie zastępuje procesu ani kolejki komend.
  - Files: `studio/src/storage/{schema,commands,checkpoints}.ts`, `studio/src/orchestration/worker.ts`, `studio/test/recovery/`.
  - Verify: G04/G14, rzeczywiste osobne procesy, blokada drugiej instancji, pełny dysk/locked DB/zgodność wersji; skuteczny cancel/revise przed zakończeniem celowo zatrzymanej odpowiedzi providera.
- [ ] **T6 (P1, człowiek 1–2 dni / agent 3–6 h)** — rewizje — Powiąż wyniki i akceptacje z niezmiennymi rewizjami.
  - Surfaced by: D6; nadpisanie formatu nie zachowuje zatwierdzonego stanu.
  - Files: `studio/src/storage/{revisions,approvals,artifacts}.ts`, `studio/test/revisions/`.
  - Verify: G05/G12, dwie karty, double click, późny wynik po korekcie, atomowa publikacja pliku; osobne tożsamości operacji i reuse assetów, korekta stylu napisów bez HeyGen/głosu.
- [ ] **T7 (P1, człowiek 2–4 dni / agent 6–12 h)** — providery/media — Opakuj istniejące narzędzia i sprawdź zewnętrzne integracje.
  - Surfaced by: D7; nieznane granice submit/status i integracji OpenShorts/video-use/HeyGen.
  - Files: `studio/src/providers/`, `studio/src/media/adapters/`, `studio/test/providers/`.
  - Verify: G06/G09; utrwal repo/wersję narzędzia i wyniki próby eksportu cięć/kadrów. Quote rozdziela estimate i maxLiability z ograniczeniami żądania. Fikcyjny timeout nie powoduje drugiego submit. Rzeczywisty kosztowy test dopiero z limitem i dostępem.
- [ ] **T8 (P1, człowiek 2–3 dni / agent 5–10 h)** — API/UI — Udostępnij stan, akceptacje i korekty z kontrolą dostępu.
  - Surfaced by: D8; autoryzacja projektu/rewizji i dostęp do narzędzi nie były opisane.
  - Files: `studio/src/api/`, `studio/web/`, `studio/test/api/`, `studio/test/ui/`.
  - Verify: G13/G15/G18, brak kluczy w przeglądarce, Origin/CSRF, poprawny projekt, reconnect, widoczne błędy i anulowanie.
- [ ] **T9 (P1, człowiek 1–2 dni / agent 3–6 h)** — harness — Zbuduj jawne replay/live i wiarygodne porównanie konfiguracji.
  - Surfaced by: D9; zero ocen i niepełne swap nie mogą przechodzić.
  - Files: `studio/eval/{runner,scorers,report}.ts`, `studio/test/eval/`.
  - Verify: G08/G09, wymagany error blokuje, prawdziwe nowe dane w swap, zakaz sieci replay, komplet manifestu/kosztów/metryk; każde powtórzenie live wywołuje model mimo pełnego cache, bez single-flight między próbami.
- [ ] **T10 (P1, człowiek 1–3 dni / agent 4–8 h)** — benchmark — Utrwal źródła, adnotacje i reguły odbioru E0–E5.
  - Surfaced by: D10; ground nie zawiera pełnych etykiet i nowe źródła nie są fixture’ami.
  - Files: `studio/eval/fixtures/`, `studio/eval/manifests/`, `studio/eval/acceptance/`.
  - Verify: trzy unikalne źródła Hypit i osobne warianty; hashe, dowody adnotacji, progi zamrożone przed eksperymentem; Qwen/Julian oraz wybrany podcast oznaczone jako gotowe dopiero po sprawdzeniu.
- [ ] **T11 (P1, człowiek 1–2 dni / agent 3–6 h)** — budżet — Wspólnie ogranicz koszt, retry i współbieżność.
  - Surfaced by: D11; limity każdego agenta nie ograniczają sumy wydatków.
  - Files: `studio/src/storage/reservations.ts`, `studio/src/orchestration/limits.ts`, `studio/test/budgets/`.
  - Verify: G11, jednoczesne rezerwacje maksymalnych zobowiązań mieszczą się w limicie; koszt > estimate, naruszenie maxLiability i opóźnione rozliczenie; unknown nie zwalnia środków, cancel blokuje nowe operacje; provider bez górnej granicy odrzucony w trybie ograniczonym.
- [ ] **T12 (P2, człowiek 1–2 dni / agent 3–6 h)** — zasoby — Współdziel obserwacje i ogranicz pamięć/dysk.
  - Surfaced by: D12; cache i źródła mogą dublować płatne obliczenia.
  - Files: `studio/src/media/{observations,cache,chunks}.ts`, `studio/test/resources/`.
  - Verify: G07/G14/G16, zgodne zakresy współdzielone, zmieniony prompt unieważnia zależne wyniki, aktywne/zaakceptowane pliki chronione; nowa rewizja nie regeneruje zgodnych assetów, zmiana jednego assetu zachowuje niezależne.
- [ ] **T13 (P1, człowiek 2–4 dni / agent 6–12 h)** — integracja — Przejdź uzgodnione scenariusze i odbiór filmu.
  - Surfaced by: D10; testy modułów nie potwierdzają pełnego procesu.
  - Files: `studio/test/integration/`, `studio/eval/scenarios/`, `studio/src/integrations/agent-os.ts`.
  - Verify: E0–E3, podcast E4, Qwen/Julian/HeyGen E5, korekta bez zbędnej pracy, oba wejścia do tej samej aplikacji; zapisz faktyczny wynik i koszt.
- [ ] **T14 (P1, człowiek 1–2 dni / agent 3–6 h)** — wydanie — Przygotuj paczkę i CI instalacji.
  - Surfaced by: D1; niezależny kod musi być instalowalny.
  - Files: `.github/workflows/studio.yml`, `studio/scripts/package.mjs`, `studio/README.md`, `studio/test/install/`.
  - Verify: built artifact w czystym HOME na obu platformach, wersje narzędzi, restart, offline fixture render, jasna diagnostyka brakującego providera. Nie publikuj bez osobnej autoryzacji.

## Zależności

| Krok | Moduły | Zależy od |
|---|---|---|
| T1 | package/build, test/install | — |
| T2 | contracts, formats/import | T1 |
| T3 | formats/timing, formats/compile | T2 |
| T4 | orchestration | T2, T5, T6 |
| T5 | storage, orchestration/worker | T1, T2 |
| T6 | storage | T5 |
| T7 | providers, media/adapters | T2; live dopiero po T11 |
| T8 | api, web | T4, T6, T11 |
| T9 | eval runner/scorers, test/eval | T2, T10 |
| T10 | eval fixtures/manifests/acceptance | —; finalny eksport schematu po T2 |
| T11 | storage, orchestration | T5, T6 |
| T12 | media, test/resources | T2, T7; publikacja artefaktów przez API T6 |
| T13 | integration, scenariusze, adapter Agent OS | T3, T4, T7, T8, T9, T11, T12 |
| T14 | build/CI, install, README | T1, T13 |

## Tory pracy i konflikty

T1/T2 ustanawiają wspólny kontrakt. T10 może równolegle zbierać adnotacje źródeł,
bez zmiany kontraktu. Następnie:

- A: T3 — formaty i czas.
- B: T5 → T6 → T4 → T11 — storage i orkiestracja, sekwencyjnie w tych modułach.
- C: T7 → T12 — providery i media; T7 testuje atrapy, zanim T11 dopuści live.
- D: T10 → T9 — benchmark i harness.

T8 po potrzebnych częściach B; T13 po połączeniu wyników; T14 zamyka wydanie.
Testy są w podkatalogach właściciela, bez wspólnego edytowanego indexu testów.
package/lockfile i contracts modyfikuje jeden integrator. T1 i T14 dotykają tych
samych modułów, ale są sekwencyjne. Zmiana schema podczas A–D wymaga uzgodnionej
rewizji kontraktu przed kontynuacją zależnych zadań.

Wszystkie tory w osobnych worktree; wspólna baza musi zawierać świadomie wybrane
niezatwierdzone jeszcze pliki obecnego prototypu. Sam HEAD nie zawiera Template,
części pomiarów ani evali. Nie kopiować sekretów/cache i nie używać `git add -A`.
Testy operują na fixture’ach w katalogach tymczasowych. Nikt nie instaluje zmian
do żywego Agent OS podczas równoległej pracy.

Diagramy przepływu i stanów utrzymujemy także przy implementacji: T4 przy
`orchestration/graph.ts`, T5 przy `orchestration/worker.ts` (komendy niezależne od
czekającej generacji), T6 przy `storage/revisions.ts` (unieważnianie zależności),
T7 przy rejestrze operacji dostawcy oraz T11 przy rezerwacjach i rozliczeniu.
