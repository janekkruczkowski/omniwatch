# OmniWatch — plan testów i odbioru

Przygotowany przez plan-eng-review, 2026-09-22, gałąź `omni/codex-handoff`, repo
`janekkruczkowski/omniwatch`. Status: wymagania do implementacji, **testy niewykonane**.
Zakres: [SPEC A0–A15](SPEC.md), [projekt techniczny D5–D11](TECHNICAL.md).

## Strony i wejścia

- Agent OS `/omniwatch`: URL, summary jako domyślne, temat, teardown, dalsza rozmowa,
  odsyłacze do filmu/klatek, przejście z Astrosa.
- Agent OS widok kanału i `/omniwatch-scout`: lista, pełny skan, nowe materiały,
  postęp po ponownym otwarciu, pauza/anulowanie, harmonogram Hermesa.
- Obecne `/api/omniwatch/jobs`, `/channel`, `/scout`, `/media/...`: zgodność dotychczasowych
  pól używanych przez UI, trwałe ID, błędy i odczyt wyników. Nowe paginowane odczyty nie
  zmieniają bez wersjonowania odpowiedzi dotychczasowego endpointu.
- Standalone `127.0.0.1:8765`, `/api/watch`, `/video/...`, `/frame/...`, `/i18n.json`,
  stare komendy `uv run app.py` i `uv run omniwatch.py`.
- CLI skanu wywoływane przez Hermesa przy zamkniętym panelu; Obsidian Vault z inną
  ścieżką i konwencją katalogów niż prywatny Vault autora.

## Mapa pokrycia planowanych przepływów

`NOWY` = test wymagany, nie istniejący zaliczony test. `ISTNIEJE` = test odczytany,
nie uruchomiony w tym przeglądzie. E2E obejmuje realną bazę, proces i pliki; model stubowany.

```text
URL / CLI / karta Astrosa
  -> walidacja wejścia / błędny URL / brak konfiguracji       NOWY T01
  -> tryb summary, temat, teardown                          NOWY T02 + EVAL E01–E03
  -> utworzenie operacji / szybkie podwójne kliknięcie        NOWY T03 [E2E]
  -> start procesu / start się nie udał / proces już działa  NOWY T04 [E2E]
  -> cache / pobranie / podział / upload wygasł               NOWY T05
  -> model ukończył / urwał stream / brak metryki kosztu      NOWY T06
  -> bufor / dysk pełny / SQLite zajęty                      NOWY T07 [E2E]
  -> Vault lub lokalny zapis / konflikt / brak dostępu       NOWY T08 [E2E]
  -> wynik i fragment filmu                                NOWY T09 [E2E]
       -> karta A po zmianie filmu na B                     ISTNIEJE card-source.test.mjs
       -> dalsze pytanie, parent A / brak kontekstu / limit  NOWY T10 + EVAL E04

kanał -> enumeracja complete/partial/error/empty              NOWY T11
      -> wiele stron / duplikaty / prywatny film             NOWY T11
      -> zakres + koszt / odmowa płatnego listowania         NOWY T12 [E2E]
      -> snapshot -> ta sama operacja manual/Hermes          NOWY T13 [E2E]
      -> 0 nowych / 2 nowe / zmieniony cel / limit           NOWY T13
      -> zamknięcie karty / restart panelu / restart worker  NOWY T14 [E2E]
      -> cancel/pause / współdzielona operacja / wznowienie  NOWY T14

Vault -> odszukanie / pytanie PL / brak dowodów / zły path    NOWY T15 [E2E] + EVAL E05
wydanie -> świeża instalacja / aktualizacja / rollback       NOWY T16 [E2E]
beta -> config / cache legacy / Markdown / stare CLI + SSE   NOWY T17 [E2E]
10k pozycji -> historia/postęp/paginacja/cache                NOWY T18
```

Pokrycie nowej architektury nie jest zmierzone. Zidentyfikowano 18 grup testów do
wykonania oraz 5 grup ewaluacji; nie przeliczamy tego na fikcyjny procent pokrycia kodu.
Istniejące testy produkcji filmów nie dowodzą odbioru nowego rdzenia analizy.

## Konkretne testy i awarie

Proponowane testy biblioteki: `packages/omniwatch/test/*.test.mjs` na zbudowanym JS,
`node:test` + `assert`. Testy instalacyjne: `test/install/`. UI: Playwright ze stubem
modelu i rzeczywistym runtime. Repo ma własne przypięte zależności testowe.

| ID / plik do utworzenia | Warunek i obserwowalny wynik | Awaria / informacja dla użytkownika |
|---|---|---|
| T01 `input.test.mjs` | URL każdej platformy, Unicode, zła długość/tryb, lokalny adres, traversal i symlink poza katalogiem; odrzucone wejście nie odpala procesu/modelu | Czytelny błąd walidacji, bez sekretów |
| T02 `analysis-contract.test.mjs` | Pusty focus = summary, focus trafia do promptu, teardown zachowany; CLI i oba adaptery otrzymują ten sam wynik ze stuba | Brak konfiguracji widoczny przed kosztowną pracą |
| T03 `operations.test.mjs` | Dwa procesy i dwa przebiegi tej samej pracy -> jedna operacja i jedno wywołanie; inny focus/parent -> osobna operacja | Powtórne kliknięcie pokazuje istniejącą pracę |
| T04 `runtime.test.mjs` | Start/koniec procesu, równoczesne enqueue/exit, zły executable, restart rodzica, stary token właściciela | Zadanie nie zostaje jako „running” bez procesu; stary właściciel nie zapisuje wyniku |
| T05 `sources.test.mjs` | Cache hit/miss, Python ID/metadata, brak filmu, upload wygasł, timeout narzędzia, nieobsługiwany typ reklamy | Błąd konkretnego materiału, zachowane inne wyniki |
| T06 `provider.test.mjs` | Stub sukces/rejection/429/5xx/reset po wysłaniu/urwany stream/brak znacznika końca; liczba prób i kompletność tekstu | Niepewna próba = wymaga sprawdzenia; brak użycia = koszt nieznany |
| T07 `recovery.test.mjs` | Przerwanie przed/po zapisie zamiaru, po odpowiedzi, przed/po COMMIT; pełny dysk, busy i błąd migracji | Zatrzymanie nowej płatnej pracy; żadnego fallbacku do RAM |
| T08 `delivery.test.mjs` | Niedostępny Vault, duplikat dostarczenia, przerwanie po rename przed referencją, plik edytowany przez człowieka | Gotowy wynik zachowany; ponowienie zapisu bez modelu; konflikt nie nadpisuje pliku |
| T09 `test/e2e/single-video.spec.ts` | Wklej URL, czytaj, wybierz teardown, przejdź do timestampu; zamknij/otwórz kartę, utrata połączenia, HTTP 500 | Czytelny postęp/błąd, poprawny film na karcie; brak nowej pracy od pollingu |
| T10 `conversation.test.mjs` + UI | „Rozwiń punkt 2”, dwie gałęzie do parent, zmiana filmu A→B, limit historii; sprawdzić question/focus, mapowanie legacy q i rzeczywiste messages wysłane do stuba | Właściwa historia i film; limit wyjaśniony, nic nie jest po cichu ucięte |
| T11 `listing.test.mjs` | 1201 filmów i powtarzające się strony; ograniczony Instagram, błąd drugiej zakładki YouTube, zero wyników | Complete tylko po pełnej enumeracji; empty odróżnione od failure |
| T12 `test/e2e/channel.spec.ts` | Koszt listowania X/Ads pokazany przed requestem; rezygnacja = zero płatnych calli; zakres all większy niż partia | Limit/nieznany koszt wstrzymuje, nie znika reszta kolejki |
| T13 `scan.test.mjs` | Snapshot manual i cron ten sam; 0 nowych = 0 model calls i cisza; 2 nowe = 2 analizy; nowy cel nie podmienia starych; timeout launchera → ukończenie → raport przy następnym cron bez model call | Raport nowej wiedzy i jawne ograniczenie zakresu |
| T14 `test/e2e/lifecycle.spec.ts` | Zabić panel, potem worker między częściami; odtworzyć ID; pauza/anulowanie dwóch współdzielonych przebiegów | Skończone wyniki zachowane; unknown bez retry; zakończenie jednego konsumenta nie kasuje drugiemu pracy |
| T15 `test/e2e/vault.spec.ts` | Dwie notatki, pytanie po polsku, temat nieobecny, usunięta/zmieniona notatka; URL instrukcji w treści filmu | Cytowane właściwe notatki i źródła, brak halucynacji oraz wykonania instrukcji z danych |
| T16 `test/install/release.test.mjs` | Ten sam tarball na clean host/standalone, build hosta, zła suma kontrolna, brak narzędzia, zmieniony obcy plik, rollback, aktywny worker; pauza → zgodna aktualizacja → identyczny snapshot requestu; niezgodna wersja odrzucona | Preflight przed zmianami; bez kasowania danych i route'ów drugiego projektu |
| T17 `test/install/python-beta.test.mjs` | Stare komendy/port/env/SSE, legacy ID i czas cache; migracja dwukrotnie, brak Node, niepełne pliki; SHA analiz przed/po | Brak model calls podczas migracji, stare analizy czytelne i powrót do bety możliwy |
| T18 `performance.test.mjs` | 10k metadanych, 50/stronę, wzrost liczby notatek, polling, cache quota i aktywny plik, duży lokalny film | Ograniczony payload/RAM, stronicowanie; brak miejsca = pauza, aktywne dane nienaruszone |

Wszystkie powyższe ścieżki mają zaprojektowaną obsługę błędu i test. To zobowiązanie
planu; obsługa nie jest jeszcze wdrożona. Na etapie realizacji cicha awaria bez testu
jest blokadą odbioru. Wyłączona/uszkodzona integracja nie może udawać sukcesu.

## Ewaluacje jakości D10

Zestaw własnych lub dozwolonych próbek: krótki film z faktem wyłącznie na ekranie,
film edukacyjny o kilku wątkach, materiał o narzędziach AI, przykład montażowy oraz
film dłuższy niż limit pojedynczej części. Bez analizowania całego publicznego kanału.
Źródła/oczekiwane fakty zapisane z timestampami, wersją promptu/modelu i ustawieniami.

| ID | Co porównujemy i co blokuje wydanie |
|---|---|
| E01 obraz+dźwięk | Prawidłowy istotny fakt z ekranu i jego fragment; odpowiedź wyłącznie z transkrypcji nie zalicza A1 |
| E02 summary + temat | Streszczenie relacjonuje materiał; temat zawęża odpowiedź; temat nieobecny jest jawny, brak dopisanych „faktów” |
| E03 teardown | Opisuje konstrukcję, montaż, tekst i dźwięk z odniesieniami; nie uruchamia generowania nowego filmu |
| E04 follow-up | Po summary i teardown „rozwiń drugi punkt” trafia we właściwy punkt/film; negatywna próba A→B nie miesza źródeł |
| E05 pamięć | Pytanie o dwie analizy, po polsku, zwraca odsyłacze i odróżnia brak informacji; polecenie w źródle nie steruje narzędziami |

Baseline: zapisane odpowiedzi bety i obecnego TS na tych samych próbkach, jeśli istnieją;
inaczej przygotowany jawny wzorzec oczekiwanych faktów. Nie uruchamiamy starego i nowego
modelu bez końca dla identyczności zdań. Każdy przypadek ma ocenę człowieka:
zgodność ze źródłem, właściwy tryb/temat, poprawne odniesienia, kompletność istotnego
fragmentu. Błędne przypisanie źródła, pominięcie wymaganego faktu wizualnego lub
bezpodstawne twierdzenie blokują odbiór; nie przykrywamy ich średnią punktów.

Testy płatne są osobnym, jawnym poleceniem z limitem prób/kosztu, nigdy efektem
`npm test`. Budżet i dostępne klucze sprawdza wykonawca przed ich uruchomieniem.
Zmieniony prompt/model/podział materiału uruchamia właściwe E01–E05; zmiana samego
instalatora wymaga instalacyjnych E2E, nie ponownego płatnego benchmarku.

## Kolejność odbioru

1. T0 zamraża fixture'y i kontrakty; testy powstają razem z modułami T1–T8 z [TASKS](TASKS.md).
2. Offline: typy, unit/contract, prawdziwy SQLite i procesy na kontrolowanych danych.
3. UI z modelem stubowanym, następnie czyste instalacje i migracja na macOS/Windows;
   Linux także dla docelowej instalacji Agent OS. Manifest wsparcia wynika z tych testów.
4. Ograniczone E01–E05 i próby źródeł; wynik dostępności platform z datą i środowiskiem.
5. Pilotaż społeczności: odbiorca sam instaluje, analizuje jeden film, robi mały skan,
   odnajduje wynik w pamięci i uruchamia aktualizację Hermesa.

Proponowane skrypty do utworzenia w T0: `npm run build`, `npm run typecheck`,
`npm test`, `npm run test:integration`, `npm run test:e2e`, `npm run test:install`,
`npm run eval:omniwatch`. To przyszłe komendy, nie twierdzenie o istniejącym CI.
Czas analizy modelu nie jest gwarantowanym SLO. Dla testu 10k pozycji raportujemy
czas strony/postępu oraz peak RSS; docelowo lokalny odczyt strony p95 < 250 ms,
przyrost RAM procesu kolejki < 100 MiB względem pustej kolejki. Przekroczenie wymaga
profilowania przed wydaniem, bez samoczynnego dokładania serwera lub vector DB.
