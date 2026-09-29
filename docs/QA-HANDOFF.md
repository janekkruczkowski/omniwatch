# Odbiór obu produktów w przeglądarce

2026-09-22. Dyspozycja Jana: po otrzymaniu gotowego wyniku OmniWatcha lub studia
root samodzielnie przeprowadza rzeczywisty odbiór end-to-end w przeglądarce ze
skillem gstack `qa`, zwraca błędy wykonawcy i ponawia odbiór po poprawkach.
Nie czeka na kolejną zgodę na zwykłe decyzje techniczne.

## Uruchomienie i odpowiedzialność

- Gotowość agenta rozpoczyna odbiór, nie oznacza gotowości produktu.
- Root czyta aktualny SKILL.md `gstack-qa` przy rozpoczęciu właściwego QA.
  Standardowy zakres: działanie i błędy utrudniające użycie; design studia odłożony.
- Można uruchomić lokalne serwery deweloperskie i przygotować środowisko testowe
  Agent OS. Hermes już istnieje lokalnie: sprawdzić jego konfigurację i użyć
  odizolowanych danych testowych. Nie nadpisywać prywatnego Vaulta/konfiguracji,
  nie zostawiać próbnych cyklicznych zadań ani równoległych konsumentów produkcyjnej kolejki.
- Koordynator oddaje stabilną rewizję i instrukcję uruchomienia. Root testuje tę
  wersję; późniejsze poprawki wykonawcy mają jednoznaczną nową rewizję do retestu.
  Nie stashować cudzej pracy tylko po to, by uzyskać czyste drzewo QA.
- Root reprodukuje błąd, zapisuje oczekiwany/faktyczny wynik, kroki, materiał,
  screenshot i błędy konsoli. Koordynator poprawia; root sprawdza ponownie ten
  scenariusz i dotknięte przepływy. Naprawy nie zastępują niezależnej weryfikacji.

## OmniWatch

W przeglądarce sprawdzić: pojedynczy URL → summary; summary z tematem; teardown;
dalsze pytanie z kontekstem; odświeżenie/wznowienie; zapis i odczyt we właściwej
pamięci Vault; skan i ponowne uruchomienie bez duplikatów; ścieżkę Hermes → wynik
widoczny w aplikacji; standalone oraz wejście z Agent OS. Sprawdzić błędy i anulowanie.
Zachować rozróżnienie między atrapą dostawcy a rzeczywistą analizą filmu.

## Studio

Sprawdzić realne wejście → wynik przez przeglądarkę: nowy/zapisany format,
podgląd i bramki, pomijanie zbędnych etapów, treść/assety, produkcja, odtwarzanie
MP4 i korekta. Powiązać odbiór z artefaktami E0–E5; sam mockup nie jest wynikiem.
Prosta korekta napisów nie może generować nowego głosu. Wynik zapisany w pliku
i prezentowany w aplikacji musi odpowiadać tej samej rewizji.

## Autonomia i granice

Zwykłe pytania agentów root rozstrzyga sam. Do Jana trafia tylko decyzja wymagająca
jego dostępu, zwiększenia budżetu lub istotnej zmiany celu. QA studia korzysta
z pozostałej części wspólnego limitu API 25 USD, nie z nowego limitu 25 USD.
Nie tworzyć nowego budżetu dla OmniWatcha przez analogię. Brak testu live oznaczać
jawnie; nie deklarować pełnego odbioru na podstawie stubów/unit testów.

Raport końcowy rozdziela: przetestowane i działające, poprawione i ponownie
sprawdzone, nadal zepsute, niewykonane z powodu zewnętrznej blokady. Raport zawiera
rewizję, URL/port, komendy startu, dowody i koszt rzeczywistych wywołań.
Po odbiorze zatrzymać własne serwery/procesy testowe, chyba że Jan potrzebuje demo.

## Protokół zdarzeń — 2026-09-22

Koordynatorzy wysyłają `send_message` do root: `READY_FOR_QA` (stabilna rewizja,
artefakt/hash, start, dowody testów, koszt, braki) albo `BLOCKED` (dowód i powód).
Po dostawie kończą turn przez final_answer. Harness dostarcza wiadomości i zakończenia.
Root podczas oczekiwania używa `collaboration.wait_agent`, które czeka na wiadomość,
a nie odpytuje statusu wykonawcy. Timeout nie jest powodem do pingowania agenta.
Nie kończy pracy samą informacją „czekam”, zanim nie obsłuży przekazania.
Po zdarzeniu root: interrupt ukończonego dziecka → niezależne QA →
`QA_CHANGES_REQUESTED` przez followup_task albo `QA_ACCEPTED` z raportem.
Błąd wykonania agenta również wymaga obsługi, nie jest zakończeniem projektu.

To protokół w aktywnym zadaniu, nie zainstalowany trwały hook w aplikacji.
Dostępne narzędzia nie dają konfiguracji jednorazowego wybudzenia zakończonego
root-turn przez dziecko. Nie twierdzimy, że sam tekst w pliku zapewnia wybudzenie
po zamknięciu aplikacji. Nie tworzymy cyklicznego pollingu jako substytutu.

Checklisty root: [OmniWatch](omniwatch/QA-CHECKLIST.md),
[Studio](video-formats/QA-CHECKLIST.md). Szczegółowe T01–T18/G01–G18 i E0–E5
pozostają obowiązujące; checkbox bez dowodu nie zalicza testu.

## Dodatkowa ścieżka wybudzenia root przez Codex App

Po faktycznej dostawie koordynator wywołuje jednorazowo `mcp__codex_app__send_message_to_thread`
z `threadId=01a0c965-4e16-7b71-9ea9-860fe8299e52` i promptem zawierającym
READY_FOR_QA, rewizję, raport/artefakt, koszt i polecenie kontynuacji niezależnego QA.
Przy nierozwiązywalnej blokadzie analogicznie BLOCKED z dowodem. To bezpośrednia
kontynuacja istniejącego zadania, bez harmonogramu i pollingu. Wysyłać raz na dostawę,
sprawdzić wynik narzędzia, odrzucenie zgłosić przez collaboration.
Użytkownik jawnie upoważnił agentów do wybudzania root. Mechanizm przekazany
wykonawcom; pierwszy skuteczny handoff przez tę ścieżkę jeszcze NIEZWERYFIKOWANY.
Nie gwarantuje działania przy wyłączonym hoście/aplikacji.

## Dyspozycja Jana: naprawy aż do skutku

Wykonawca naprawia i powtarza własne testy aż do usunięcia zgłoszonych usterek. Root następnie niezależnie wykonuje checklistę; każdy niezaliczony odbiór wraca jako QA_CHANGES_REQUESTED i wznawia tę samą pętlę. Raport, commit ani zielone testy jednostkowe nie zamykają zadania. Pętla kończy się potwierdzonym odbiorem albo udokumentowaną zewnętrzną blokadą wymagającą dostępu/decyzji użytkownika; nadal obowiązują granice kosztów i ochrona danych.
