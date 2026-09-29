# OmniWatch — zapis drugiego odczytu planu

2026-09-22. Zewnętrzny Claude Code: niedostępny, błąd uwierzytelnienia, bez wyniku
recenzji. Zgodnie z wywołanym plan-eng-review użyto natywnego recenzenta z osobnym
kontekstem. To dodatkowy odczyt w tej samej sesji narzędziowej, nie niezależne
potwierdzenie zewnętrznego modelu. Recenzent nie zmieniał plików.

## Pierwszy wynik — pełna treść

[P2] Wznowienie po aktualizacji nie ma kompletnego kontraktu wersji. TECHNICAL.md:141
zamraża prompt/model skanu, ale TECHNICAL.md:110 zachowuje starą paczkę tylko do końca
życia procesu. Wstrzymany skan może przeżyć proces i aktualizację. Poprawka: zachowywać
wersję wykonawczą do zakończenia wszystkich zależnych operacji albo utrwalać kompletną,
odtwarzalną specyfikację wywołań. Dodać odbiór: pauza → aktualizacja → wznowienie.

[P2] Kontrakt żądania nie zawiera bieżącego pytania. TECHNICAL.md:123 wymienia focus
i identyfikatory rozmowy, natomiast TECHNICAL.md:187 wymaga przesłania bieżącego pytania
oraz historii. Poprawka: dodać question albo jawnie ustalić, że focus przenosi także
pytanie; określić mapowanie legacy q i udział pytania w analysisKey.

[P2] Brakuje dostarczenia końcowego raportu po timeoutcie launchera Hermesa.
TECHNICAL.md:221 obiecuje raport nowych wyników, lecz timeout kończy się jedynie
podaniem ID. Nie wskazano, kto później odbierze wynik ani ponowi niedostarczone
powiadomienie wymagane przez SPEC.md:165. Poprawka: ustalić trwały raport per przebieg
i mechanizm ponownego odczytu/dostarczenia przez Hermesa, bez nowej analizy; dodać test
ukończenia skanu po timeoutcie launchera.

Recommendation: Revise these contracts before final approval because they leave observable behavior undefined across upgrades, follow-up requests, and long-running scheduled scans.

## Korekty autora

Wszystkie trzy zalecenia włączono do projektu do wspólnej akceptacji, zgodnie z prośbą
użytkownika o samodzielne rozstrzygnięcia. To uszczegółowienia D5/D8/D9 i testów,
nie nowe funkcje produktu. Numery linii powyżej dotyczą wersji sprzed korekt.

- Snapshot wywołania i jego zgodność przy aktualizacji; aktualizacja nieobsługująca
  wstrzymanej operacji jest blokowana; test w T16.
- Osobne focus/question, mapowanie starego q i udział w kluczu; test w T10.
- Trwały raport i odbiór przy następnym uruchomieniu Hermesa, raport-only na żądanie;
  rozróżnienie stdout od potwierdzenia dostarczenia; test w T13.

## Weryfikacja poprawek — pełna treść

Wszystkie trzy uwagi zostały domknięte na poziomie planu:

- Wznowienie zachowuje snapshot; niezgodna aktualizacja jest blokowana, również przy
  wstrzymanych operacjach. T16 obejmuje oba przypadki.
- question i focus mają osobne znaczenie, mapowanie legacy q oraz udział w kluczu.
  T10 sprawdza kontrakt.
- Raport jest trwały, odbierany po timeoutcie przy kolejnym uruchomieniu; ponowienie
  raportu nie analizuje filmu. Potwierdzenie dostarczenia jest odróżnione od stdout.
  T13 obejmuje późne zakończenie.

Nie znalazłem materialnej sprzeczności w tych poprawkach. To weryfikacja dokumentacji,
nie wykonania testów.

Recommendation: Submit the plan for final approval because all three identified contract gaps are now explicitly addressed.

## Trwałość raportu

Wyniki są w repo: PLAN, TECHNICAL, TEST-PLAN, TASKS, tasks-eng-review.jsonl oraz
[review-record.json](review-record.json). Próby aktualizacji globalnego dziennika
`~/.gstack` i skopiowania tam artefaktów zostały zablokowane przez uprawnienia systemu
plików. `gstack-review-read` zwrócił NO_REVIEWS; nie oznaczono globalnego dashboardu
jako zaliczonego. Nie blokuje to przeglądu dokumentów zapisanych w repo.
