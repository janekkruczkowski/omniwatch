# Zadania interfejsu — propozycje po przeglądzie

2026-09-22. Doprecyzowanie istniejącego T8, z odbiorem przez T13/T14 z [TASKS](TASKS.md).
Nie są dodatkowymi równoległymi zadaniami obok implementacji tego samego T8.
**Odłożone na prośbę Jana.** Nie uruchamiać U1–U6 i nie uzależniać od nich silnika.
To notatki do ewentualnego przyszłego projektu UI, nie aktywne zadania ani
zatwierdzony kierunek graficzny. Szacunki orientacyjne, nie pomiar pracy.

## Odłożone propozycje

- [ ] **U1 (P1, człowiek 1–2 dni / agent 3–6 h)** — obszar pracy — Zbuduj wspólny układ projektu i tokeny.
  - Surfaced by: UX1/UX8, brak hierarchii i systemu wizualnego studia.
  - Files: `studio/web/components/ProjectShell.tsx`, `studio/web/styles/tokens.css`, `studio/test/ui/shell.spec.ts`.
  - Verify: podgląd ma priorytet, właściwe etykiety wersji, lista projektów i przejście do formatów; dwa motywy i brak zależności od fontów systemowych.
- [ ] **U2 (P1, człowiek 1–2 dni / agent 3–6 h)** — wejście — Dodaj materiały z rolami i wybór zapisanego formatu.
  - Surfaced by: UX2, brak możliwości skorygowania interpretacji źródeł.
  - Files: `studio/web/components/ProjectInput.tsx`, `studio/web/components/FormatLibrary.tsx`, `studio/test/ui/inputs.spec.ts`.
  - Verify: temat bez plików, nowa referencja, materiał w obu rolach, gotowe assety; zapisany format pomija analizę i powtórną bramkę.
- [ ] **U3 (P1, człowiek 2–3 dni / agent 4–8 h)** — podglądy — Rozróżnij format, treść odcinka i odbiór filmu.
  - Surfaced by: UX3/UX4, różne znaczenia akceptacji oraz brak drogi do źródeł.
  - Files: `studio/web/components/ArtifactPreview.tsx`, `studio/web/components/EpisodeScenes.tsx`, `studio/web/components/ApprovalBar.tsx`, `studio/test/ui/approvals.spec.ts`.
  - Verify: placeholder nie jest finalnym filmem; pełny scenariusz, czas źródła i czas wyniku; właściwa wersja akceptacji i eksportu, brak sukcesu przy brakującym materiale.
- [ ] **U4 (P1, człowiek 1–2 dni / agent 3–6 h)** — wykonanie — Pokaż koszty, wybraną pracę i konkretne drogi odzyskania.
  - Surfaced by: UX5/UX7, setup całego zestawu narzędzi i ogólne błędy utrudniają użycie.
  - Files: `studio/web/components/ExecutionStatus.tsx`, `studio/web/components/CostReview.tsx`, `studio/test/ui/recovery.spec.ts`.
  - Verify: komplet tabeli stanów UX §7; brak powtórnego submit przy unknown, przyjęcie cancel oddzielone od skutku, rozliczono/rezerwacja/limit; powrót po reconnect.
- [ ] **U5 (P1, człowiek 1–2 dni / agent 3–6 h)** — korekty — Powiąż rozmowę z celem zmiany i historią wersji.
  - Surfaced by: UX6, niejasna granica formatu i odcinka w rozmowie.
  - Files: `studio/web/components/CorrectionPanel.tsx`, `studio/web/components/RevisionHistory.tsx`, `studio/test/ui/corrections.spec.ts`.
  - Verify: ta sama prośba na formacie i odcinku ma właściwy zakres; tylko wygląd napisów nie regeneruje głosu; wcześniejszy film zachowuje własną wersję; fokus i draft nie giną.
- [ ] **U6 (P1, człowiek 1–2 dni / agent 3–6 h)** — odbiór UI — Zweryfikuj małe ekrany, klawiaturę, czytnik i skrajne stany.
  - Surfaced by: UX9 oraz pełne zachowanie UX1–UX8.
  - Files: `studio/test/ui/accessibility.spec.ts`, `studio/test/ui/responsive.spec.ts`, `studio/test/integration/studio-journeys.test.mjs`.
  - Verify: 320/375/768/1024/1440 px, dwa motywy, powiększenie, długie teksty, brak hover-only, naturalny fokus, VoiceOver, rzeczywiste playback/QA/eksport w E4/E5.

U1 → U2/U3 → U4/U5 → U6 to kolejność integracji w obrębie właściciela T8.
U2 i U3 można wydzielić dopiero po stabilnym shellu/kontraktach, bez wspólnego
edytowania routingu i tokenów. U4 potrzebuje mechanizmów T5/T6/T11, U5 rewizji
T6. U6 jest odbiorem przekrojowym, ale kryteria dostępności obowiązują od U1.
Nie odkładamy testów działania na późniejszy kosmetyczny audyt.

Nie eksportowano tych notatek do uzgodnionego backlogu skilla. Jeśli wrócimy do
designu, najpierw oceniamy je wobec działającego silnika; nie zlecamy T8 i U1–U6
dwóm zespołom równolegle.
