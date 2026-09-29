# Plan testów studia filmowego

2026-09-22, plan-eng-review, branch `omni/codex-handoff`. Plan przyszłego odbioru,
nie lista testów już zaliczonych. W repo wykryto `node:test` w plikach `.test.mjs`;
część obecnych testów transpile'uje TS przez zależności z Agent OS. Nowy pakiet
ma budować TS samodzielnie i testować JS przez node:test; UI przez Playwright.

## Diagram pokrycia

```text
API/komenda [G13,G18 →E2E]
 ├─ błędne wejście/uprawnienia → 4xx, brak pracy
 ├─ powtórka/stara rewizja → poprzedni wynik / 409 [G05 →E2E]
 └─ queued → worker/checkpoint [G04 →E2E]
      ├─ zły/stary format → migracja lub needs_review [G01 unit]
      ├─ koordynator → plan → walidator [G03 unit+E3 →EVAL]
      │    ├─ gotowe wyniki → reuse [G07,G09]
      │    ├─ brak analizy → analiza formatu/treści [E1 →EVAL]
      │    └─ wymagany montaż → sourceSpans [G10,E4 →E2E/EVAL]
      ├─ nowa treść → kompletność slotów [G02,E3]
      ├─ potrzebna generacja → reserve/submit/status [G06,G11 →E2E]
      │    ├─ timeout/unknown → reconciliation/needs_attention
      │    └─ gotowy plik → atomic publish [G14]
      ├─ QA fail → poprawa / limit [G03,G11,E2/E3]
      ├─ akceptacja → resume/correction/cancel [G05,G12 →E2E]
      └─ resolve timing → compose → render → QA [G10,G15,G17 →E2E/E5]
```

Istnieją testy pomocników: template, episode, node, cues, recipe, motion, hard-rules,
director-contract. Odczytano reprezentatywne testy, nie uruchamiano całego zestawu.
Ich istnienie nie dowodzi pokrycia przyszłego API, trwałego grafu ani rewizji.
Poniższe G01–G18 są wymaganiami nowego odbioru; nie wyliczamy pozornego coverage %.

## Grupy, awarie i odbiór

| ID / proponowany plik pod studio/test | Wejścia i asercje | Awaria / zachowanie użytkownika |
|---|---|---|
| G01 contracts.test.mjs | Format round-trip, oba stare importy, recipe/ruch, zła wersja, brak ref, duplicate ID, NaN | Migracja lub jawne needs_review; oryginał zachowany |
| G02 episode.test.mjs | Pełne/niepełne nowe sloty, fixed, preview examples, brak treści, długość > limit | needs_input; brak cichego użycia referencji i brak submit |
| G03 planner.test.mjs + E3 | Cykle, nieznane capability, zły typ, 7 scenariuszy routingu, rewizja planu, limit QA | Zły plan odrzucony; poprawka albo widoczny problem |
| G04 recovery.test.mjs | Osobne procesy, restart węzła/przed checkpointem/po nim, druga instancja workera, zła wersja grafu, provider z celowo nierozstrzygniętą odpowiedzią | Wznowienie zgodnej wersji lub jasna odmowa; cancel/revise skuteczne przed końcem wywołania |
| G05 approvals.test.mjs | Dwie karty, double click, refresh, stara approval, zgodny format bez nowej bramki | Idempotentny wynik/409; akceptowana właściwa rewizja |
| G06 operations.test.mjs | Crash przed submit/po przyjęciu/przed zapisem ID/po zapisie; replay checkpointu; poll timeout | Brak drugiego niekontrolowanego submit; unknown widoczny |
| G07 reuse.test.mjs | Równoległe prośby o tę samą obserwację, inny prompt/model/zakres, konflikt reducerów; zmiana rewizji i jednego z niezależnych assetów | Jedno zgodne wywołanie; artifactReuseKey zachowuje niezmienione wyniki; zmiana unieważnia wyłącznie zależnych potomków |
| G08 harness.test.mjs | Zero scored, required error, skipped, częściowy raport, przerwanie, zły baseline, próba sieci E0; N powtórzeń live przy zapełnionym cache | Niezerowy exit przy brakach; replay bez sieci; N osobnych wywołań wybranej konfiguracji w live, z identyfikatorami |
| G09 transforms.test.mjs | Prawdziwy swap z kontrolą nowych danych, reuse complete assets, prompt modelu koordynatora | Zmiana tylko właściwych pól; brak zbędnej generacji |
| G10 timing.test.mjs | Krótsza/dłuższa mowa, brak anchor, wielokrotne słowo, cut w środku słowa, wiele sourceSpans | Wyliczone nowe czasy lub korekta planu; brak starej sekundy |
| G11 budgets.test.mjs | Równoległe rezerwacje maksymalnych zobowiązań, retry SDK/QA, unknown cost, 429, cancel; koszt > estimate; brak górnej granicy; opóźnione rozliczenie | Brak nowych operacji ponad zarezerwowany limit; unknown trzyma rezerwację; bez granicy odmowa w trybie ograniczonym; naruszenie granicy przez dostawcę jawnie wstrzymuje pracę |
| G12 revisions.test.mjs | Korekta podczas generacji, późny callback/result, zmiana grafu, cancel; tylko wygląd napisów; zmiana tekstu wypowiedzi | Stary wynik nie mutuje filmu; potwierdzenie skutku komendy przed końcem generacji; styl napisów = zero nowych wywołań HeyGen/głosu, nowy render/QA; zmiana mowy aktualizuje czas |
| G13 api.test.mjs | Nieuprawniona komenda, cudzy projectId, zły Origin/CSRF, utrata sesji | 4xx bez mutacji; użytkownik może wrócić do stanu |
| G14 storage.test.mjs | Pełny dysk, niepełny plik, uszkodzony hash, DB locked, retention aktywnego zadania | Nowa praca wstrzymana; brak zaakceptowanego niepełnego pliku |
| G15 media-safety.test.mjs | Symlink/path traversal, URL do localhost, redirect, shell znaki, niepoprawny HTML | Odrzucenie wejścia przed narzędziem; ograniczony renderer |
| G16 resources.test.mjs | Długi film w porcjach, nakładanie fragmentów, limity klatek/pamięci/cache | Limit albo jawne needs_attention; zachowane globalne czasy |
| G17 integration.test.mjs + E4/E5 | Podcast: twarze/kadry/sens; Qwen: dowody/scenariusz/HeyGen/cuts/captions/MP4 | Błąd konkretnego etapu z możliwością poprawki; pełny odbiór E5 |
| G18 ui.spec.ts + installation.test.mjs | Czysta instalacja, create/reload/resume/correct/cancel/download w obu wejściach | Czytelny postęp, brak zależności od prywatnego repo Jana |

Każda nowa gałąź implementacji ma zostać przypisana do powyższej grupy lub
rozszerzyć ją w tym samym zadaniu. Brak danych wejściowych nie staje się testem
zaliczonym. Faktyczną jakość testu ocenia asercja zachowania i ścieżka awarii.

## Affected Pages/Routes — propozycja

- `/studio` i `/studio/projects/:id`: utworzenie, stan, podgląd, czat korekt, eksport.
- `/api/studio/projects`: create; `/api/studio/projects/:id/commands`: approve/revise/cancel.
- `/api/studio/projects/:id`: odczyt stanu; `/events`: postęp z odtworzeniem po reconnect.
- Adapter Agent OS otwierający ten sam projekt; bez kopiowania całego modułu OmniWatcha.

## Krytyczne przepływy użytkownika

1. Wybiera zapisany format i temat: brak analizy referencji, pełny odcinek i QA.
2. Wybiera nową referencję: tani ruchomy podgląd, QA i akceptacja; zamyka kartę,
   wraca, zatwierdza i kontynuuje bez utraty pracy.
3. Daje podcast: widzi wybrany fragment/osoby i podgląd przed właściwym odbiorem.
4. Qwen/Julian: widzi zgodność pokazu ze scenariuszem, prezentera i czytelne napisy.
5. Poprawia wygląd napisów: nowy render i QA, bez generowania głosu/prezentera.
   Zmienia jeden niezależny asset: ponownie powstaje ten asset i zależne wyniki.
   Zmienia treść wypowiedzi: nowe audio i zależne czasy, jeśli są potrzebne.
6. Brak limitu/kredytu/pliku albo awaria: jasny etap i sposób powrotu; brak fałszywego sukcesu.
7. Anuluje/poprawia przy trwającym wywołaniu: widzi potwierdzenie skutku komendy
   przed końcem generacji; osobno informację o operacji, która może nadal naliczyć koszt.

## Uzupełnienie odbioru UI po plan-design-review — propozycja

**Odłożone razem z designem na prośbę Jana.** Poniższe sprawdzamy przy realizacji
interfejsu, nie jako warunek pierwszego odbioru silnika E0–E3. Wymagania o rolach,
rewizjach, kosztach i pomijaniu pracy nadal sprawdzamy na poziomie kontraktów
i harnessu; nie wymagają gotowych ekranów.

W ramach G18/G05/G12/G13, bez tworzenia równoległego zestawu tych samych testów:

- UX1/UX2: temat bez źródeł, plik w obu rolach, korekta roli, zapisany format
  pomija ponowną analizę/bramkę, gotowe assety nie powodują dodatkowej generacji.
- UX3/UX4: jawny typ podglądu i placeholdery, konkretna wersja akceptacji,
  pełny scenariusz, odnośnik do fragmentu źródła i rozdzielenie obu osi czasu.
- UX5/UX7: stan każdego pola i widoku z tabel UX §7, brak providera tylko dla
  potrzebnego kroku, uczciwa rezerwacja kosztu, celowane działania po błędzie.
- UX6: ta sama poprawka na formacie i odcinku, jawny cel, zachowana historia,
  późny wynik nie podmienia oglądanego filmu, prosta korekta nie mnoży bramek.
- UX8/UX9: 320/375/768/1024/1440 px, oba motywy, długi tytuł/link/tekst,
  klawiatura i VoiceOver, zachowanie draftu/fokusu/czasu po przełączeniu widoku,
  wyłączenie ruchu, kontrast i cele dotykowe. Pomiar na rzeczywistym rendererze.

Makieta sprawdzana podczas review nie zastępuje powyższego odbioru aplikacji.

## Polecenia odbioru — do utworzenia w T1

`npm --prefix studio ci`, `npm --prefix studio run build`,
`npm --prefix studio run test:unit`, `npm --prefix studio run test:integration`,
`npm --prefix studio run test:ui`, `npm --prefix studio run eval:replay`.
`eval:live` przyjmuje manifest i jawny limit kosztu. Wymaga realnych providerów,
więc nie jest automatyczną częścią testu każdego pliku. Smoke release uruchamia
zbudowaną paczkę w czystym katalogu, nie źródła z checkoutu.
