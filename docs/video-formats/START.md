# Tworzenie filmów z formatów — punkt wyjścia

**Aktualne doprecyzowanie celu:** [CONCEPT.md](CONCEPT.md). Produkt obejmuje
łączenie analizy materiału, montażu i generowania, z opcjonalnym wejściem z Astros.
Format i treść mają niezależne źródła. Poniżej zachowano rozpoznanie istniejącej aplikacji.

**Plan po przeglądzie inżynierskim:** [TECHNICAL.md](TECHNICAL.md),
[odbiór](TEST-PLAN.md) i [zadania z zależnościami](TASKS.md).
Plan i delegacja zaakceptowane z limitem API 25 USD: [ACCEPTANCE](ACCEPTANCE.md).
**Aktualny priorytet Jana: silnik i evale.** Projekt interfejsu [UX.md](UX.md)
i [raport przeglądu](DESIGN-REVIEW.md) odkładamy. Szkic służył rozmowie o przebiegu
pracy, nie jest propozycją docelowego wyglądu. E0–E3 nie czekają na UI.

Zaakceptowana [delegacja do DeepSeek V4.1 Flash](DELEGATION.md).
Koordynator przejmuje wykonanie i odbiór.

2026-09-22. Wznowione rozważania o drugim, niezależnym produkcie. Nazwa katalogu jest
robocza. OmniWatch (rozumienie istniejących filmów) ma osobny zatwierdzony plan i
pracujących autonomicznie wykonawców. Tutaj ustalamy cel narzędzia do tworzenia/montażu;
nie uruchamiamy starego backlogu napraw jako domyślnego planu produktu.

## Cel zapisany wcześniej

Człowiek znajduje film o interesującym formacie, wykorzystuje jego strukturę do
własnego materiału i dostaje gotowy film. Wewnętrzna praca agentów jest częścią
narzędzia, a nie wymaganiem obsługi agenta kodującego przez użytkownika.
Źródło: [HANDOFF, §4a](../../HANDOFF-CLONE-PIPELINE.md).

Drugą wartością jest powtarzalność: raz przygotowany format można zapisać i używać
do kolejnych odcinków z inną treścią. Użytkownik nie musi odtwarzać za każdym razem
układu, rytmu, napisów i sposobu prezentacji.

To opis historycznej intencji. Nie rozstrzyga jeszcze pierwszego odbiorcy, zakresu
wkładu użytkownika, dopuszczalnej ręcznej korekty ani kryterium użyteczności POC.
Nie zakładamy automatycznie celu „dowolny film → idealne odtworzenie”.

## Stan: zaawansowany prototyp techniczny

Podstawa: [STAN](../../agent-os-module/docs/STAN.md), lokalne wiki i odczyt CLI.
Poniższe nie jest nowym uruchomieniem testów, renderów ani providerów.

| Obszar | Co już jest | Czego ten dowód nie potwierdza |
|---|---|---|
| Rozpoznanie i pomiar | Capture, pomiar geometrii, czasy słów, opis kompozycji | Niezawodności dla dowolnego filmu i formatu |
| Render | Kompozycja HTML/GSAP i MP4, przykłady rankingu/podcastu/wywiadu | Samodzielnego przepływu użytkownika z nową treścią bez ręcznych ingerencji |
| Szablony | CLI `--save-template`, `--from-template`, osobna struktura i dane odcinka | Gotowego interfejsu biblioteki lub automatycznej poprawności każdego szablonu |
| Podmiany | `--content` z JSON i `--host`; generowanie obrazków | Że zapisane testy `swap-*` rzeczywiście podmieniały treść — STAN §7 temu przeczy |
| Edycja rozmową | W dokumentacji przewidziane miejsce integracji | Działającego czatowego edytora szablonu |
| Odbiór | Historyczne testy jednostkowe i raporty pomiarów/renderów | Gotowości produktu; ewaluacja ma ograniczenia |

Ostatni zapisany raport generowania miał 4/8 przypadków spełniających ówczesne
kryteria. Punkt odniesienia bywał mierzony ponownie, a przypadki podmian nie podawały
nowej treści. Nie interpretujemy tego jako wiarygodnego „50% skuteczności produktu”.
STAN odróżnia historyczne 226 testów od późniejszego powtórzenia tylko wybranego zestawu.

CLI jest konkretnym wejściem prototypu: `agent-os-module/scripts/clone-film.mjs`.
Zapisane formaty obsługuje `omniwatchTemplate.ts`. Odtworzenie formatu bez ponownego
pomiaru jest udokumentowane; nie oznacza renderowania pełnego filmu bez narzędzi.
Brakujące zdjęcia lub prowadzący mogą pozostać jawnymi pustymi miejscami.

## Co trzeba rozdzielić w specyfikacji

1. Pozyskanie lub przygotowanie formatu z filmu referencyjnego.
2. Stworzenie nowego odcinka z własną treścią w tym formacie.
3. Poprawienie formatu/odcinka przez użytkownika.

To etapy doświadczenia jednego produktu, nie decyzja o trzech osobnych aplikacjach.
Dotychczas najwięcej pracy dotyczyło pierwszego etapu i dokładności renderu. Dla POC
trzeba ustalić, który cały scenariusz daje odbiorcy wartość i jak to sprawdzimy.

Nie wybieramy jeszcze nowych silników, limitów formatów ani kolejności napraw na
podstawie tego, co jest najłatwiejsze do zmiany w obecnym kodzie. Stare założenie
„model nie podaje liczb ciągłych” jest zapisaną decyzją techniczną poprzedniej ścieżki;
nie zastępuje celu produktu i może być ocenione dopiero względem zakresu POC.

## Ścieżka dalszych rozważań

Stan i intencja → odbiorca i jego zadanie → zakres POC / przegląd produktowy gstack
→ specyfikacja z przykładem wejścia i wyniku → przegląd inżynierski → zadania.

**Decyzja użytkownika:** pierwszy POC jest dla Jana i ma sprawdzić jego rzeczywisty
proces tworzenia filmów. Społeczność ani sprzedaż klientom nie definiują teraz odbioru.
Korekta użytkownika: przed pytaniami o konkretny POC należy odtworzyć działanie
istniejącej aplikacji ze statusu i wiki, w tym analiz Hypit, video-use i OpenShorts.
Nie rozpoczynamy definiowania produktu od zera ani od wyboru przykładowego filmu.

## Uzupełnienie: aplikacja i ewolucja mechanizmu produkcji

[DESIGN §8e](../../DESIGN.md) opisuje sprawdzoną 2026-09-20 ścieżkę:
Astros → obejrzenie filmu → „Make one like this” → własny temat → Director
z briefem → scenariusz, prezenter lub lektor, b-roll → montaż → HyperFrames.
Przenoszony jest rytm referencji, a treść powstaje dla własnego tematu. To zapisany
wynik wcześniejszego sprawdzenia, nie nowy test wykonany podczas planowania.

[CLONING](../../agent-os-module/CLONING.md) opisuje bogatszą reprezentację:
regiony, warstwy, zawartość zmieniająca się w czasie, napisy i rozdział stałego
formatu od treści odcinka. Element można narysować, wygenerować, wyciąć z materiału
lub dostarczyć jako autentyczny plik. Endpointy pozwalają analizować, weryfikować,
tworzyć treść odcinka i produkować film. Nowszy STAN doprecyzowuje pomiar:
model rozpoznaje znaczenie, piksele geometrię, aligner czasy słów.

Istnieją dwa mechanizmy zapisu: starsza biblioteka formatów (`deriveFormat`,
`omniwatchFormats.ts`) i bogatsze szablony CLI (`omniwatchTemplate.ts`) zachowujące
recipe oraz ruch. Nie należy utożsamiać ich ani przedstawiać CLI jako całej aplikacji.
Zapisana ścieżka Directora nie dowodzi kompletnego spięcia nowszego mechanizmu
szablonów z interfejsem i edycją rozmową.

W [analizie konkurencji](../../RESEARCH-CLONE-ARCHITECTURES.md) Hypit jest punktem
odniesienia dla filmu jako programu opisującego strukturę i animację; OpenShorts
dla ograniczonych decyzji modelu i reguł egzekwowanych kodem; video-use dla pracy
agenta na transkrypcji i podglądach oraz zasad montażowych. Wniosek projektu:
bogaty opis struktury, ale reguły wykonania w kodzie. Są to wnioski z zapisanej
analizy, a nie nowy przegląd aktualnych wersji konkurencji.

Drobne decyzje techniczne autor przygotuje samodzielnie i zbierze do jednej akceptacji,
zgodnie z preferencją użytkownika z rozmowy o OmniWatchu. Brakującego celu i potrzeb
odbiorcy nie zastępujemy domysłami. Bez zmian kodu i bez mieszania tych prac z
bieżącym wykonaniem OmniWatcha przez oddelegowany zespół.
