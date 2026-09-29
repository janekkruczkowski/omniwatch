# Checklist odbioru — OmniWatch

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
| T01 `input.test.mjs` | URL każdej platformy, Unicode, zła długość/tryb, lokalny adres, traversal i symlink poza katalogiem; odrzucone wejście nie odpala procesu/modelu; Czytelny błąd walidacji, bez sekretów | TODO | — |
| T02 `analysis-contract.test.mjs` | Pusty focus = summary, focus trafia do promptu, teardown zachowany; CLI i oba adaptery otrzymują ten sam wynik ze stuba; Brak konfiguracji widoczny przed kosztowną pracą | TODO | — |
| T03 `operations.test.mjs` | Dwa procesy i dwa przebiegi tej samej pracy -> jedna operacja i jedno wywołanie; inny focus/parent -> osobna operacja; Powtórne kliknięcie pokazuje istniejącą pracę | TODO | — |
| T04 `runtime.test.mjs` | Start/koniec procesu, równoczesne enqueue/exit, zły executable, restart rodzica, stary token właściciela; Zadanie nie zostaje jako „running” bez procesu; stary właściciel nie zapisuje wyniku | TODO | — |
| T05 `sources.test.mjs` | Cache hit/miss, Python ID/metadata, brak filmu, upload wygasł, timeout narzędzia, nieobsługiwany typ reklamy; Błąd konkretnego materiału, zachowane inne wyniki | TODO | — |
| T06 `provider.test.mjs` | Stub sukces/rejection/429/5xx/reset po wysłaniu/urwany stream/brak znacznika końca; liczba prób i kompletność tekstu; Niepewna próba = wymaga sprawdzenia; brak użycia = koszt nieznany | TODO | — |
| T07 `recovery.test.mjs` | Przerwanie przed/po zapisie zamiaru, po odpowiedzi, przed/po COMMIT; pełny dysk, busy i błąd migracji; Zatrzymanie nowej płatnej pracy; żadnego fallbacku do RAM | TODO | — |
| T08 `delivery.test.mjs` | Niedostępny Vault, duplikat dostarczenia, przerwanie po rename przed referencją, plik edytowany przez człowieka; Gotowy wynik zachowany; ponowienie zapisu bez modelu; konflikt nie nadpisuje pliku | TODO | — |
| T09 `test/e2e/single-video.spec.ts` | Wklej URL, czytaj, wybierz teardown, przejdź do timestampu; zamknij/otwórz kartę, utrata połączenia, HTTP 500; Czytelny postęp/błąd, poprawny film na karcie; brak nowej pracy od pollingu | TODO | — |
| T10 `conversation.test.mjs` + UI | „Rozwiń punkt 2”, dwie gałęzie do parent, zmiana filmu A→B, limit historii; sprawdzić question/focus, mapowanie legacy q i rzeczywiste messages wysłane do stuba; Właściwa historia i film; limit wyjaśniony, nic nie jest po cichu ucięte | TODO | — |
| T11 `listing.test.mjs` | 1201 filmów i powtarzające się strony; ograniczony Instagram, błąd drugiej zakładki YouTube, zero wyników; Complete tylko po pełnej enumeracji; empty odróżnione od failure | TODO | — |
| T12 `test/e2e/channel.spec.ts` | Koszt listowania X/Ads pokazany przed requestem; rezygnacja = zero płatnych calli; zakres all większy niż partia; Limit/nieznany koszt wstrzymuje, nie znika reszta kolejki | TODO | — |
| T13 `scan.test.mjs` | Snapshot manual i cron ten sam; 0 nowych = 0 model calls i cisza; 2 nowe = 2 analizy; nowy cel nie podmienia starych; timeout launchera → ukończenie → raport przy następnym cron bez model call; Raport nowej wiedzy i jawne ograniczenie zakresu | TODO | — |
| T14 `test/e2e/lifecycle.spec.ts` | Zabić panel, potem worker między częściami; odtworzyć ID; pauza/anulowanie dwóch współdzielonych przebiegów; Skończone wyniki zachowane; unknown bez retry; zakończenie jednego konsumenta nie kasuje drugiemu pracy | TODO | — |
| T15 `test/e2e/vault.spec.ts` | Dwie notatki, pytanie po polsku, temat nieobecny, usunięta/zmieniona notatka; URL instrukcji w treści filmu; Cytowane właściwe notatki i źródła, brak halucynacji oraz wykonania instrukcji z danych | TODO | — |
| T16 `test/install/release.test.mjs` | Ten sam tarball na clean host/standalone, build hosta, zła suma kontrolna, brak narzędzia, zmieniony obcy plik, rollback, aktywny worker; pauza → zgodna aktualizacja → identyczny snapshot requestu; niezgodna wersja odrzucona; Preflight przed zmianami; bez kasowania danych i route'ów drugiego projektu | TODO | — |
| T17 `test/install/python-beta.test.mjs` | Stare komendy/port/env/SSE, legacy ID i czas cache; migracja dwukrotnie, brak Node, niepełne pliki; SHA analiz przed/po; Brak model calls podczas migracji, stare analizy czytelne i powrót do bety możliwy | TODO | — |
| T18 `performance.test.mjs` | 10k metadanych, 50/stronę, wzrost liczby notatek, polling, cache quota i aktywny plik, duży lokalny film; Ograniczony payload/RAM, stronicowanie; brak miejsca = pauza, aktywne dane nienaruszone | TODO | — |

## Przejście ręczne w przeglądarce — w standalone i Agent OS

- [ ] M01: pusty/błędny URL i brak konfiguracji → czytelny końcowy błąd, zero płatnej pracy, działająca ponowna próba.
- [ ] M02: prawdziwy pojedynczy film → domyślne streszczenie; tekst zgodny z obrazem i dźwiękiem (E01/E02).
- [ ] M03: ten sam materiał z tematem → skupienie na temacie; nieobecny temat jawnie rozpoznany (E02).
- [ ] M04: teardown → konstrukcja/montaż/napisy/dźwięk, właściwe timestampy (E03).
- [ ] M05: „rozwiń punkt 2” po obu trybach → właściwy kontekst; nowy film nie dziedziczy starej rozmowy (E04).
- [ ] M06: odtwarzanie, przewijanie i kliknięcie timestampu; wszystkie miniatury mają rzeczywisty obraz.
- [ ] M07: odświeżenie, ponowne otwarcie, utrata połączenia i dwukrotne kliknięcie → bez zdublowanego zadania.
- [ ] M08: timeout/500/urwany stream → brak wiecznego spinnera i fałszywego sukcesu; bez ślepego płatnego retry.
- [ ] M09: przełączanie trybów i języka, powrót do formularza i odczyt zapisanej analizy.
- [ ] M10: nowa analiza z Agent OS faktycznie zapisana w testowym Vault; otwarcie przez widok pamięci. Ręcznie utworzona notatka nie zalicza zapisu.
- [ ] M11: wyszukanie dwóch analiz i pytania po polsku; odsyłacze do właściwych notatek, brak wiedzy jawny (E05).
- [ ] M12: mały skan kanału → biblioteka osobnych analiz, postęp i faktyczny zakres complete/partial.
- [ ] M13: ponowny skan bez nowych filmów → zero analiz; kontrolowane dwa nowe → tylko dwie analizy.
- [ ] M14: pauza/anulowanie/wznowienie i restart panelu/workera w partii; gotowe wyniki zachowane.
- [ ] M15: rzeczywisty lokalny Hermes uruchamia skan przy zamkniętej karcie; wynik widoczny w Agent OS, brak podwójnej pracy manual/cron.
- [ ] M16: link z Astrosa trafia do działającego narzędzia; instalacja aktualizuje również UI i trasy.
- [ ] M17: próbki YouTube, TikTok, Instagram, X i obsługiwanych Facebook Ads: zapisać dostępność każdej platformy oddzielnie, ograniczenia i datę. Nie deklarować wszystkich na podstawie YouTube.
- [ ] M18: beta Python → TS: stare komendy i konfiguracja, istniejące analizy, powtórna migracja i rollback bez utraty danych i nowych wywołań.
- [ ] M19: długi film/porcje → globalne timestampy, spójność i brak pominiętego wymaganego fragmentu.
- [ ] M20: klawiatura i wąski ekran → możliwe wykonanie głównego przepływu; bez prac nad stylistyką.

## Otwarte regresje z pierwszego QA

| Błąd | Stan przy tworzeniu checklisty | Warunek zamknięcia |
|---|---|---|
| ISSUE-001 instrukcja instalacji | FAIL | Dokładna komenda z handoffu działa na czystym celu |
| ISSUE-002 stary interfejs po instalacji | FAIL | Nowa paczka instaluje działające UI i trasy Agent OS |
| ISSUE-003 spinner po błędzie | FAIL | Błąd kończy postęp; poprawa wejścia pozwala wykonać nową próbę |
| ISSUE-004 domyślny adres API | FAIL | Realna analiza z kluczem i domyślnym adresem; poprawne upload/chat endpointy |
| ISSUE-005 uszkodzone miniatury | PASS root e77af24: 16/16 obrazów | Nowo pobrany film ma wygenerowane i widoczne klatki |

Dotychczasowy [raport root](/Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/qa-omniwatch-20260922/QA-REPORT.md) zawiera częściowe dowody. Powyższe grupy nie są jeszcze odebrane w całości. Koszt QA OmniWatcha nie korzysta z limitu studia przez analogię.

## Zamknięcie odbioru

- [ ] Każdy wymagany przypadek ma wynik i dowód; FAIL/BLOCKED wykluczają deklarację pełnego odbioru.
- [ ] Poprawki ponownie sprawdzone przez root na nowej rewizji oraz adekwatne regresje.
- [ ] Raport końcowy rozdziela live, stub, replay, niewykonane i odłożone; zawiera koszt i ograniczenia.
- [ ] Zatrzymane własne procesy testowe i usunięte wyłącznie własne próbne harmonogramy; dane użytkownika nienaruszone.

## Aktualizacja wykonania root

2026-09-22: pojedyncze realne summary działa (139 s, koszt raportowany 0.01327617 USD), ISSUE-005 potwierdzony po poprawce. M02 częściowo: poprawny transport i wynik; pełna kontrola faktów nadal TODO. M05/M07/M08 FAIL dla współbieżności: utrata właściciela runtime podczas dwóch requestów, niezakończony stan running. ISSUE-006 blokuje Agent OS (kompilacja ChannelScan), ISSUE-007 blokuje równoległe zadania standalone. M04 teardown rozpoczęty, wynik jeszcze nieodebrany. Zobacz aktualny raport root; nie ma pełnego odbioru.

## Odbiór23września

44kontrolowane testy vault/channel/lifecycle/conversation/analysis-contract PASSroot; nie zastępują liveM05/M10. RzeczywistyHermescronrun i due crontick uruchamiają produktowylauncher/sharedCLI na fixture:2analizy2wywołania2notatki, kolejneprzebiegi0nowych0calls. M13FAIL: drugi0new ponawia raport; trzeci cichy. ISSUE009 ack/reportsourcecount wnaprawie. M15częściowoPASS realnydispatcherprzyzamkniętympanelu; gatewayautowake nietestowany. M10FAIL/blockedISSUE008 panel pomijaAGENTIC_OS_CONFIG i domyślnyVaultma pierwszeństwo przedAGENTIC_OS_VAULT; root przerwałliveanalizę, deliveries0. Nowakosztownapróbama wyniknieznany i niejestponawiana. Dowody ../qa-omniwatch-20260922/QA-REPORT.md oraz hermes-root-qa/REPORT.md.
