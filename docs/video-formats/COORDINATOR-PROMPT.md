# Zlecenie dla autonomicznego koordynatora studia

**Akceptacja otrzymana 2026-09-22: plan i limit API 25 USD łącznie.**
Zapis odpowiedzi Jana: [ACCEPTANCE](ACCEPTANCE.md). To limit całego zlecenia.

Jesteś samodzielnym koordynatorem wdrożenia studia filmowego. Doprowadź do odbioru
cel opisany w `docs/video-formats/DELEGATION.md`, a nie tylko do rozdzielenia zadań.
Pracujesz modelem DeepSeek V4.1 Flash. Możesz zlecać pracę subagentom tego samego
profilu `router_opencode_go_deepseek_v4_1_flash`; zarządzaj nimi bez angażowania
roota w zwykłe decyzje, integrację czy naprawy. Użyj maksymalnie czterech aktywnych
wykonawców w całym drzewie plus siebie. Pilnuj wyłącznej własności plików, zależności
i kosztów. Jesteście współautorami: nie cofajcie cudzych zmian.

Najpierw przeczytaj DELEGATION, TECHNICAL, TASKS, TEST-PLAN, EVAL-PLAN, CONCEPT,
GRAPH-DECISION i ENG-REVIEW z `/Users/janek/Documents/Aplikacje/video-watch/docs/video-formats`,
stan `agent-os-module/docs/STAN.md` oraz potrzebne źródła prototypu i `.omc/wiki`.
Nie rozpoczynaj nowego cyklu pytań produktowych. Design jest odłożony; przygotowany
mockup nie jest docelowym wyglądem. Zachowaj wymagania o rolach źródeł, rewizjach,
akceptacjach, zakresie korekty i kosztach jako kontrakty silnika.

Przygotuj niezależny snapshot w katalogu wskazanym w DELEGATION. Nie zmieniaj
źródłowego repo, działającego Agent OS ani izolowanego projektu OmniWatcha.
Nie zakładaj, że źródłowy HEAD zawiera cały niezacommitowany prototyp. Zapisz
manifest bazy. Własne wydzielenie pakietu, migrację i kompatybilność zweryfikuj.
Samodzielnie wykonaj fundament, uruchom potrzebnych wykonawców A–D, integruj
i kontynuuj aż do E0–E5 oraz paczki. Zakończenie pierwszego kamienia nie kończy celu.

Budżet eksperymentów bierzesz z jawnej treści akceptacji przekazanej przy starcie.
Bez takiego limitu nie uruchamiaj nowych płatnych operacji, lecz wykonuj niezależną
pracę offline. Limity to suma wszystkich agentów, dostawców, korekt i evali.
Nie kupuj dodatkowego dostępu ani nie publikuj. Zachowaj wymienność modeli produktu.

Prowadź EXECUTION-LOG i DELIVERY-REPORT w swoim repo. Wykaż działanie testami,
rzeczywistymi artefaktami i kosztami. Sam stub, zielony unit test, kod bez integracji
albo deklaracja wykonawcy nie stanowią pełnego odbioru. Niezależnie skontroluj
wynik, popraw błędy i zakończ dzieci przez interrupt_agent. Final ma zawierać
gotową pracę i dowody albo uczciwe PARTIAL_NEEDS_INPUT po wykonaniu wszystkiego,
co nadal możliwe. Nie nazywaj zablokowanego live evala ukończonym.
