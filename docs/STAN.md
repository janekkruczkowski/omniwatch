# Stan projektów — 2026-09-23

Aktualny punkt wejścia dla kolejnej sesji. Dwa niezależne produkty: OmniWatch i Studio filmowe. Żaden nie ma jeszcze pełnego odbioru QA. Dostawa kodu przez agenta nie oznacza odbioru produktu.

## Uzgodniony cel i zakres

**OmniWatch:** oszczędność czasu i pozyskiwanie wiedzy z filmów, prywatnie i biznesowo. Domyślnie streszczenie pojedynczego filmu, opcjonalny temat streszczenia, teardown oraz dalsze pytania. Obsługa wielu platform jest celem, ale nie należy deklarować jej na podstawie samego YouTube. Samodzielna beta Python była już wydana (MIT); prace dotyczą migracji i rozwinięcia, nie pierwszego wydania produktu. Wersja dla społeczności Agent OS korzysta z istniejącego Obsidian Vaulta. Skan kanału daje bibliotekę osobnych analiz, bez obowiązkowego wspólnego opracowania. Hermes dodaje harmonogram. Zakres skanowania/pamięci płatnego clouda pozostaje osobną decyzją.

Uzgodniona architektura: jedna biblioteka TypeScript z modułami wewnętrznymi, lokalny SQLite na stan wykonania, Vault jako pamięć wiedzy. Migracja bety ma zachować dane. Udostępnienie społeczności ma dostarczyć obiecaną wartość i budować wiarygodność autora.

**Studio filmowe:** rozpoznanie i zapis formatu referencyjnego, następnie tworzenie nowego filmu w tym formacie. Zapisany format pozwala pominąć analizę; rozumienie dostarczonych treści jest oddzielnym etapem. Orkiestrator wybiera potrzebne kroki. Silnik i powtarzalne evale mają pierwszeństwo przed designem. Benchmark obejmuje przypadki konkurencji, podcast oraz docelowy przykład prezentacja Qwen + prezenter HeyGen + napisy/montaż. Testy mają umożliwiać ocenę zmiany modelu, prompta, jakości i kosztu.

## Lokalizacje i rewizje

Wspólny katalog roboczy dostaw: `/Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni`.

| Element | Lokalizacja / stan |
|---|---|
| Dokumentacja i historyczny kod | `/Users/janek/Documents/Aplikacje/video-watch` — drzewo zawiera wcześniejsze modyfikacje i pliki nieśledzone; nie resetować |
| OmniWatch — produkt | `omniwatch-autonomous`, HEAD `0ef8dc2c79344d071458afe3174f355b0a61b18b`, czyste drzewo przy zapisie |
| OmniWatch — podgląd użytkownika | `omniwatch-user-preview`, http://127.0.0.1:18767/ |
| Dane podglądu | `omniwatch-user-preview/user-data` — zachować, nie kasować podczas aktualizacji |
| Studio — produkt | `studio-autonomous`, HEAD `dfa34474e00361e9275ae23761ab406f9f4746e1`, czyste drzewo przy zapisie |
| Izolowany Agent OS do QA | `qa-omniwatch-20260922/agent-os/source`; testowy Vault obok w `test-vault` |
| Wiki poza gitem | `/Users/janek/Documents/Aplikacje/video-watch/.omc/wiki` |

Podgląd OmniWatcha jest wcześniejszym snapshotem z kopiowanymi poprawkami, **nie czystą instalacją całego aktualnego wydania**. Nie zakładać, że źródłowe repo, podgląd, instalacja Agent OS i publiczny GitHub mają tę samą wersję. Publikacja najnowszych poprawek nie została potwierdzona.

## OmniWatch — potwierdzone przez root

- Realny krótki film YouTube: analiza oraz rzeczywiste miniatury działają.
- Realny film użytkownika `https://www.youtube.com/watch?v=eF3yeJuifoQ` (34:21): dziewięć części + scalenie dały pełne streszczenie z osią czasu i polem dalszych pytań.
- Po restarcie i odświeżeniu ponowne podanie tego samego URL odczytało wynik natychmiast, bez nowych wywołań modelu: przed i po 10 odpowiedzi oraz 4 próby o nieznanym wyniku.
- Ponowienie korzysta z ukończonych części. Kontrolowany test w przeglądarce: błąd → świadome ponowienie → wynik, usunięte stare karty błędów i dostępne dalsze pytanie.
- Root: 22 testy regresji ponawiania/checkpointów i 20 testów providera PASS, bez skipów w tych przebiegach. Osobno wcześniej 44 kontrolowane testy Vault/kanały/lifecycle/rozmowa/kontrakt PASS. Nie są to dowody wszystkich przepływów live.

Naprawy długiego filmu: mniejsze części (limit 480 klatek dla Qwen3.8 w standalone), `reasoning_effort=low`, odczyt ostatniego bufora SSE także bez końcowego LF, checkpointy z hashem treści i zakresów materiału. Sam mniejszy podział nie wystarczył. Nie ustalono retrospektywnie, że każda awaria miała tę samą przyczynę.

Jednorazowe dopuszczenie starej odpowiedzi przez `OMNIWATCH_LEGACY_CHECKPOINT_ATTEMPT` usunięto z finalnego procesu po sukcesie. Serwer podglądu pozostawiono użytkownikowi (sesja wykonania 17719 w tej rozmowie; numer nie jest trwałą instrukcją startu).

Koszt widoczny dla ukończonego wyniku: około **0,142 USD**, nie całkowity koszt diagnozy. Cztery wcześniejsze próby mają nieznane rozliczenie. Nie ponawiać ich automatycznie ani przedstawiać braku danych jako kosztu zerowego.

## OmniWatch — co pozostaje

1. Rzeczywiste testy streszczenia tematycznego, teardown i dalszych pytań z kontekstem; samo aktywne pole pytania nie zalicza odpowiedzi.
2. Retest dostarczonych poprawek Agent OS: właściwy wybór konfiguracji/Vaulta, rzeczywisty zapis analizy, odczyt i wyszukiwanie notatek. Poprzednia próba została zatrzymana po wykryciu błędnego wyboru Vaulta; nie uznawać jej za sukces.
3. Retest Hermesa: skan, dostarczenie raportu, kolejny skan bez nowych filmów i bez powtórnego raportu, uruchomienie przy zamkniętym panelu. Realny dispatcher był testowany na kontrolowanym dostawcy; trwałe automatyczne wybudzanie gatewaya nie jest potwierdzone.
4. Skan małego kanału, restart/wznowienie, pauza/anulowanie i brak duplikatów manual/cron.
5. Próbki TikTok, Instagram, X i obsługiwanych Facebook Ads; zapisać osobno rzeczywiste ograniczenia dostępności.
6. Czysta instalacja najnowszej paczki w standalone i Agent OS, migracja danych bety i rollback. Dopiero po odbiorze przygotować spójne wydanie.
7. Kontrola jakości treści: w analizie długiego filmu model nazwał aktualne slajdy „fikcyjnymi/datowanymi na przyszłość”. Transport działa, ale ten błąd merytoryczny nie został naprawiony ani zweryfikowany evalem.

Poprawki ISSUE-008 (wybór Vaulta) i ISSUE-009 (raportowanie Hermesa) dostarczono; **nie mają jeszcze niezależnego końcowego retestu root**. To praca do odbioru, nie automatycznie nadal niepoprawiony kod.

## Studio — stan

Działa przepływ w przeglądarce: materiał → podgląd/zapis formatu → zatwierdzenie → rzeczywisty MP4. Root potwierdził naprawy UI: brak zalewu `skipped undefined`, działający podgląd przed zatwierdzeniem, odtwarzalny render. Poprzedni render miał problemy z wyborem fragmentu i stosowaniem zatwierdzonego formatu; zwrócono je agentowi.

Najnowsza dostawa `dfa3447` zawiera poprawione cięcie podcastu (28,3 s), użycie zatwierdzonego formatu i dowody kadrowania. Wykonawca raportuje 155 testów PASS oraz E0 replay 7/7; root wcześniej niezależnie sprawdził 153 testy poprzedniej rewizji. **Najnowsza dostawa wymaga odbioru root.**

- E4: rzeczywisty klip podcastu istnieje; raport pozostaje `requires_review`. Potrzebne odsłuchanie początku/końca, zgodności napisów i synchronizacji. Wykrycie twarzy we wszystkich klatkach nie dowodzi synchronizacji ust ani poprawności tekstu.
- E1: rzeczywisty benchmark analizy formatu nieodebrany. Automatyczna kontrola uprawnień odrzuciła wysyłkę lokalnych klatek HypeKid do OpenRouter z powodu niepotwierdzonej autoryzacji materiałów; nie obchodzono odmowy. Trzeba rozwiązać zakres uprawnienia lub użyć odpowiednio autoryzowanych danych.
- E5: pełny przykład Qwen + HeyGen + montaż nieodebrany; zgłoszony brak działającego dostępu/konfiguracji HeyGen i problem transportu. Sam renderer ani mockup nie zaliczają tego celu.
- Wspólny limit dodatkowych API dla Studia wynosi **25 USD łącznie z QA**. Nie resetować go przy kolejnej sesji; ustalić udokumentowane zużycie przed płatnym przebiegiem.

Paczka najnowszej dostawy: `/private/tmp/studio-poc-sol-dfa3447.tar.gz`, SHA-256 `01e4eaf3f9f2b2d30e3e335f63ea4221b818f4c44c4ccbdca6edb2b7d7661989`. Plik w tmp może nie przetrwać sprzątania; źródłem odtworzenia jest rewizja produktu.

## Odpowiedzialność i kolejność wznowienia

Na koniec ostatniego odbioru **żaden agent nie pracował**. Koordynatorzy GPT-6 Sol oddali poprawki i zostali zatrzymani po dostawie. Nie czekamy na ich odpowiedź. Kolejny ruch należy do root.

1. Odbiór OmniWatcha w izolowanym Agent OS i Hermesie, potem pozostałe ręczne przepływy standalone.
2. Każdy rzeczywisty błąd przekazać Solowi z reprodukcją; po dostawie ponowić niezależne QA. Wznowić przez `followup_task`, nie samo `send_message` do zatrzymanego agenta.
3. Odbiór najnowszego E4 Studia, następnie odblokowanie i wykonanie E1/E5 w granicach budżetu.
4. Zaktualizować checklisty na podstawie dowodów, przygotować spójne paczki i końcowy raport. Nie deklarować pełnego odbioru na podstawie jednego działającego filmu.

Decyzje rutynowe podejmować samodzielnie. Nie zmieniać prywatnego Vaulta, harmonogramów ani cudzych plików. Nie pozostawiać próbnych cronów. Gotowy agent ma przekazać wynik do root; root przechodzi do QA bez kolejnego pytania użytkownika. Ścieżka wybudzenia przez Codex App zadziałała dla jednej dostawy Studia, ale nie jest gwarancją pracy po wyłączeniu aplikacji.

## Dowody i dokumenty

- [Checklist OmniWatch](omniwatch/QA-CHECKLIST.md) oraz [Checklist Studio](video-formats/QA-CHECKLIST.md). Część wpisów to starsze snapshoty; niniejszy dokument określa aktualny stan, nie zalicza całych grup testów.
- [Protokół QA](QA-HANDOFF.md).
- Root OmniWatch: `/Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/qa-omniwatch-20260922/QA-REPORT.md`.
- Szczegóły długiego filmu: ten sam katalog, `issue010-long-film/REPORT.md`; screenshot `screenshots/eF3yeJuifoQ-success.png`.
- Hermes: ten sam katalog, `hermes-root-qa/REPORT.md` i `hermes-fix-qa/REPORT.md`.
- [Dotychczasowy odbiór root Studia](video-formats/QA-ROOT-20260922.md).
- Najnowsze dowody E4: `studio-autonomous/studio/eval/results/e4-podcast/{REPORT,SEMANTIC-QA,CAPTION-SYNC-QA,FACE-COVERAGE-QA}.md`.

Historyczne opisy w `STATUS.md` i `agent-os-module/docs/STAN.md` pozostają zachowane. Nie traktować ich wcześniejszych wyników, architektury ani deklaracji publikacji jako odbioru aktualnej wersji TypeScript.
