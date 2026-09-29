# Checklist odbioru — Studio filmowe

2026-09-22. Właściciel niezależnego odbioru: root. To lista do wykonania, nie deklaracja zaliczenia.
Źródło szczegółowych wejść i asercji: [TEST-PLAN.md](TEST-PLAN.md). Każdy wariant z kolumny wejść oraz awarii trzeba sprawdzić osobno; zaliczenie jednego wariantu nie zamyka grupy.

Statusy: TODO / RUNNING / PASS / FAIL / BLOCKED / DEFERRED. PASS wymaga dowodu na konkretnej rewizji. Raport wykonawcy oznaczać „agent”, odbiór root „root”; replay/stub/live zapisywać jawnie. Brak klucza, materiału lub niewykonany test nie jest PASS.
Dla każdego uruchomienia zapisać: ID i wariant, rewizję/hash paczki, środowisko, wejście i oczekiwany wynik, wynik rzeczywisty, dowód (log/screenshot/artefakt), datę, koszt i osobę wykonującą. FAIL wymaga numeru błędu, rewizji poprawki i ponownego wykonania. Testy awarii używają kontrolowanego providera; jakość treści wymaga prawdziwego materiału i modelu.

## Przed odbiorem

- [ ] Stabilna rewizja i paczka z checksumą; uruchomienie z instrukcji w czystym katalogu.
- [ ] Osobna baza, Vault, katalogi i porty; żadnych prywatnych danych w dowodach.
- [ ] Zweryfikowany dostęp i pozostały budżet; płatne testy poza zwykłym test runnerem.
- [ ] Build/typecheck i adekwatne testy wykonawcy; zapisane wszystkie skipy i błędy.
- [ ] Przegląd rzeczywistych ekranów przez gstack QA; konsola, błędy sieci, odtworzenie wyniku.

## Macierz techniczna

| Grupa | Zakres obowiązkowy (szczegółowe warianty w TEST-PLAN) | Status root | Dowód |
|---|---|---|---|
| G01 contracts.test.mjs | Format round-trip, oba stare importy, recipe/ruch, zła wersja, brak ref, duplicate ID, NaN; Migracja lub jawne needs_review; oryginał zachowany | TODO | — |
| G02 episode.test.mjs | Pełne/niepełne nowe sloty, fixed, preview examples, brak treści, długość > limit; needs_input; brak cichego użycia referencji i brak submit | TODO | — |
| G03 planner.test.mjs + E3 | Cykle, nieznane capability, zły typ, 7 scenariuszy routingu, rewizja planu, limit QA; Zły plan odrzucony; poprawka albo widoczny problem | TODO | — |
| G04 recovery.test.mjs | Osobne procesy, restart węzła/przed checkpointem/po nim, druga instancja workera, zła wersja grafu, provider z celowo nierozstrzygniętą odpowiedzią; Wznowienie zgodnej wersji lub jasna odmowa; cancel/revise skuteczne przed końcem wywołania | TODO | — |
| G05 approvals.test.mjs | Dwie karty, double click, refresh, stara approval, zgodny format bez nowej bramki; Idempotentny wynik/409; akceptowana właściwa rewizja | TODO | — |
| G06 operations.test.mjs | Crash przed submit/po przyjęciu/przed zapisem ID/po zapisie; replay checkpointu; poll timeout; Brak drugiego niekontrolowanego submit; unknown widoczny | TODO | — |
| G07 reuse.test.mjs | Równoległe prośby o tę samą obserwację, inny prompt/model/zakres, konflikt reducerów; zmiana rewizji i jednego z niezależnych assetów; Jedno zgodne wywołanie; artifactReuseKey zachowuje niezmienione wyniki; zmiana unieważnia wyłącznie zależnych potomków | TODO | — |
| G08 harness.test.mjs | Zero scored, required error, skipped, częściowy raport, przerwanie, zły baseline, próba sieci E0; N powtórzeń live przy zapełnionym cache; Niezerowy exit przy brakach; replay bez sieci; N osobnych wywołań wybranej konfiguracji w live, z identyfikatorami | TODO | — |
| G09 transforms.test.mjs | Prawdziwy swap z kontrolą nowych danych, reuse complete assets, prompt modelu koordynatora; Zmiana tylko właściwych pól; brak zbędnej generacji | TODO | — |
| G10 timing.test.mjs | Krótsza/dłuższa mowa, brak anchor, wielokrotne słowo, cut w środku słowa, wiele sourceSpans; Wyliczone nowe czasy lub korekta planu; brak starej sekundy | TODO | — |
| G11 budgets.test.mjs | Równoległe rezerwacje maksymalnych zobowiązań, retry SDK/QA, unknown cost, 429, cancel; koszt > estimate; brak górnej granicy; opóźnione rozliczenie; Brak nowych operacji ponad zarezerwowany limit; unknown trzyma rezerwację; bez granicy odmowa w trybie ograniczonym; naruszenie granicy przez dostawcę jawnie wstrzymuje pracę | TODO | — |
| G12 revisions.test.mjs | Korekta podczas generacji, późny callback/result, zmiana grafu, cancel; tylko wygląd napisów; zmiana tekstu wypowiedzi; Stary wynik nie mutuje filmu; potwierdzenie skutku komendy przed końcem generacji; styl napisów = zero nowych wywołań HeyGen/głosu, nowy render/QA; zmiana mowy aktualizuje czas | TODO | — |
| G13 api.test.mjs | Nieuprawniona komenda, cudzy projectId, zły Origin/CSRF, utrata sesji; 4xx bez mutacji; użytkownik może wrócić do stanu | TODO | — |
| G14 storage.test.mjs | Pełny dysk, niepełny plik, uszkodzony hash, DB locked, retention aktywnego zadania; Nowa praca wstrzymana; brak zaakceptowanego niepełnego pliku | TODO | — |
| G15 media-safety.test.mjs | Symlink/path traversal, URL do localhost, redirect, shell znaki, niepoprawny HTML; Odrzucenie wejścia przed narzędziem; ograniczony renderer | TODO | — |
| G16 resources.test.mjs | Długi film w porcjach, nakładanie fragmentów, limity klatek/pamięci/cache; Limit albo jawne needs_attention; zachowane globalne czasy | TODO | — |
| G17 integration.test.mjs + E4/E5 | Podcast: twarze/kadry/sens; Qwen: dowody/scenariusz/HeyGen/cuts/captions/MP4; Błąd konkretnego etapu z możliwością poprawki; pełny odbiór E5 | TODO | — |
| G18 ui.spec.ts + installation.test.mjs | Czysta instalacja, create/reload/resume/correct/cancel/download w obu wejściach; Czytelny postęp, brak zależności od prywatnego repo Jana | TODO | — |

## Przejście ręczne i jakość filmu

- [ ] M01: czysta instalacja → działający silnik/API i minimalny panel, bez prywatnych zależności.
- [ ] M02: nowa referencja → analiza → własny zapis formatu → eksport/import → identyczna semantyka (E0/E1).
- [ ] M03: przypadki HypeKid: właściwy układ, sloty, warstwy, napisy, ruch i zdarzenia; niezależne źródła liczone oddzielnie od wariantów (E1).
- [ ] M04: tani ruchomy podgląd formatu; placeholdery jawnie oznaczone, akceptacja konkretnej rewizji (E2).
- [ ] M05: zapisany format + nowy temat bez materiałów → brak analizy referencji i niepotrzebnej analizy treści (E3).
- [ ] M06: własny materiał + zapisany format → analiza tylko potrzebnej treści; format zachowany.
- [ ] M07: gotowe assety i sloty → montaż bez zbędnej generacji; fixed nie zastąpione przykładową treścią.
- [ ] M08: brak slotu, modelu lub możliwości → needs_input/needs_attention; agent nie produkuje pozornego sukcesu.
- [ ] M09: restart/zamknięcie karty → trwały postęp; dwie karty i stara akceptacja → bez podwójnej operacji.
- [ ] M10: zmiana wyglądu napisów → nowy render i QA, zero nowej mowy/HeyGen.
- [ ] M11: zmiana wypowiedzi → nowe potrzebne audio i czasy; zmiana jednego assetu nie unieważnia niezależnych wyników.
- [ ] M12: korekta/anulowanie podczas generacji → natychmiastowy stan komendy; późny wynik nie nadpisuje nowej rewizji.
- [ ] M13: podcast → dobór sensownego fragmentu, właściwe osoby/kadry, cięcia poza słowami, synchronizacja napisów (E4).
- [ ] M14: Qwen + wzorzec Juliana → zrozumienie demonstracji bez dźwięku, scenariusz oparty na dowodach, ekran 16:9 na górze, HeyGen, cięcia i napisy (E5).
- [ ] M15: finalny MP4 faktycznie odtwarzalny, poprawny obraz/dźwięk/synchronizacja; pobrany plik i podgląd są tą samą rewizją.
- [ ] M16: sourceSpans, powtarzające się słowa i krótsza/dłuższa mowa → nowe poprawne czasy, bez kopiowania sekund referencji.
- [ ] M17: budget/429/timeout/unknown → brak niekontrolowanego submit/retry; koszt nieznany jawny i rezerwacja zachowana.
- [ ] M18: konsola/błąd połączenia/reload/download i wejście z Agent OS → funkcjonalny przepływ bez makiety udającej wynik.

## Obowiązkowe dowody evali

- [ ] E0: replay bez sieci, prawdziwy round-trip i negatywne przypadki; wynik nie zastępuje analizy modelu.
- [ ] E1: live ekstrakcja wobec zamrożonych oczekiwań HypeKid; zapis wersji modelu/promptu/parametrów i ID wywołań.
- [ ] E2: rzeczywisty ruchomy podgląd, oceniony układ/napisy/ruch; prostokąty bez tekstu nie zaliczają wierności napisów.
- [ ] E3: wybór opcjonalnych kroków, zmiana tematu i reuse, restart i późny wynik; pełne wymagane scenariusze z TEST-PLAN.
- [ ] E4: rzeczywisty podcast i finalny montaż; brak materiału oznacza BLOCKED.
- [ ] E5: pełny Qwen/Julian/HeyGen → MP4, oceniony end-to-end; stub nie zalicza.
- [ ] Zmiana modelu/promptu/preprocessingu → jawne porównanie jakość/koszt/czas przy stałych progach; nie dostosowywać wzorca do wyniku.
- [ ] Zero scored / brak wymaganej próby / cache udający powtórkę live → raport niezaliczony.
- [ ] Wspólny ledger wykonawców i root: maksymalnie 25 USD łącznie; QA nie dostaje drugiego limitu.

Dopracowanie designu oraz UX8/UX9 pozostaje DEFERRED zgodnie z decyzją Jana. Działanie minimalnego UI i prawdziwe wyniki pozostają wymagane.

## Zamknięcie odbioru

- [ ] Każdy wymagany przypadek ma wynik i dowód; FAIL/BLOCKED wykluczają deklarację pełnego odbioru.
- [ ] Poprawki ponownie sprawdzone przez root na nowej rewizji oraz adekwatne regresje.
- [ ] Raport końcowy rozdziela live, stub, replay, niewykonane i odłożone; zawiera koszt i ograniczenia.
- [ ] Zatrzymane własne procesy testowe i usunięte wyłącznie własne próbne harmonogramy; dane użytkownika nienaruszone.
