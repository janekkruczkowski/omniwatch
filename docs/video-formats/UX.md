# Studio filmowe — projekt interfejsu v0.1

2026-09-22. **Odłożone na prośbę Jana: najpierw silnik i evale.**
To roboczy prototyp przepływów, nie kierunek docelowego wyglądu. Nie rozwijamy teraz
warstwy wizualnej i nie wymagamy akceptacji UX1–UX9 do pracy nad silnikiem.
Przydatne pozostają wymagania niezależne od ekranów: role źródeł, konkretna rewizja
akceptacji, zakres poprawki oraz stan i koszt wykonania. Reszta jest materiałem
do ponownego przemyślenia po sprawdzeniu silnika, nie normatywnym backlogiem.
Uzupełnia [CONCEPT](CONCEPT.md), [TECHNICAL](TECHNICAL.md) i [TEST-PLAN](TEST-PLAN.md).
Wymagania z rozmowy pozostają aktualne. UX1–UX9 poniżej są proponowanymi sposobami
ich realizacji, a nie zatwierdzonym projektem graficznym ani działającym produktem.

## 1. Obszar pracy i nawigacja (UX1)

Powierzchnia typu OPERATE: użytkownik tworzy film i ocenia materiał. Pierwszeństwo
ma podgląd, obok treść i poprawki. Koordynator wybiera pracę w tle. Nie pokazujemy
grafu agentów jako głównego ekranu ani obowiązkowego kreatora wszystkich etapów.

```text
Studio
  ├─ Projekty → Nowy film → Projekt
  │                         ├─ Format [konkretna wersja]
  │                         ├─ Treść odcinka [sceny + materiały]
  │                         └─ Film [podgląd + odbiór]
  └─ Moje formaty → Podgląd wersji → Użyj w nowym filmie

Projekt, szeroki ekran
  nazwa / zapis / wersja                         bieżący stan
  Format | Treść odcinka | Film     [dostęp do wyników, nie lista kroków]
  +--------------------------------+-----------------------------+
  | podgląd, bez przycinania        | treść lub szczegóły          |
  | materiału do ramki UI           | źródła / uwagi sprawdzenia   |
  | sterowanie / wybór momentu      | zakres i rozmowa o poprawce  |
  +--------------------------------+-----------------------------+
  co teraz zatwierdzasz / koszt                  główne działanie
```

Trzy informacje zawsze widoczne: nad czym pracuję, jaki wynik oglądam i co zrobi
główne działanie. Identyfikatory operacji, modele, prompty i pełne logi są w
„Szczegółach wykonania”. Nie wymagamy ich rozumienia do przygotowania filmu.
W Agent OS zachowujemy jego otoczenie/nawigację; w standalone ten sam projekt
ma własną lekką nawigację. Link do projektu przywraca wynik, widok i wersję.
Lista projektów: nazwa, miniatura wyniku jeśli istnieje, stan, data zmiany,
„Otwórz”. Pusta lista: „Stwórz pierwszy film” i przycisk „Nowy film”.

## 2. Przyjęcie zadania i role źródeł (UX2)

Jeden ekran „Co chcesz stworzyć?”: temat lub scenariusz, format, materiały.
Link i plik dodajemy do tego samego zestawu. Materiały są opcjonalne; brak pliku
nie blokuje filmu z samego tematu. Agent sugeruje role, użytkownik może je zmienić
bez dodatkowego obowiązkowego okna potwierdzenia.

Każdy materiał ma nazwę, rozpoznany typ, miniaturę jeśli dostępna, status dostępu
i widoczną rolę: „Wzór wyglądu”, „Materiał do odcinka”, „Obie role”. Gotowy
prezenter/głos/grafika ma dodatkowo przypisanie do właściwego elementu odcinka.
Zapisany format pokazuje nazwę i wersję. Gdy brak formatu, agent proponuje jeden
do zwykłej bramki formatu. Nie prosimy użytkownika o dobór podgrafu lub modelu.

Przed startem krótki opis zrozumianego zadania, np. „Układ z filmu Juliana,
treść z demonstracji Qwen, nowy prezenter”. Rozbieżność poprawiamy przy materiale
lub w rozmowie. Pomyłka w roli nie może uruchomić ukrytej kosztowej analizy.
Gotowy scenariusz pokazujemy jako dostarczony; nie przepisujemy go bez powodu.
Kolejność pól i rola pliku nie zależą od tego, czy użytkownik wszedł z Astros.

## 3. Trzy wyniki, trzy znaczenia akceptacji (UX3)

| Wynik | Co pokazujemy | Co zatwierdza użytkownik | Główne działanie |
|---|---|---|---|
| Format | Ruchomy podgląd, oznaczone elementy przykładowe, wersja, referencja i uwagi QA | Układ, styl i zachowania tej wersji; nie treść następnych odcinków | „Zatwierdź format” |
| Treść odcinka | Pełny scenariusz, wybrane fragmenty, materiały dostarczone/do przygotowania, koszt i zakres | Ten odcinek i plan pracy w określonym limicie | „Rozpocznij produkcję” |
| Film | Odtwarzalny wynik z właściwym audio, wersja, lista uwag QA | Konkretny film po kontroli | „Zatwierdź film”, następnie „Pobierz MP4” |

Format zapisany i zgodny nie wymaga nowej akceptacji. Ekran otwiera bieżący wynik
potrzebny do decyzji; zakładki są dostępem do dokumentów projektu, nie obowiązkiem
przechodzenia kolejno. Gotowe kompletne assety mogą prowadzić od razu do podglądu
kompozycji i renderu. Nie pokazujemy pustych „analiz” jako kroków oczekujących.

Podgląd formatu ma etykietę „Podgląd formatu • treść przykładowa”, a plan odcinka
„Podgląd montażu • elementy do przygotowania: …”. Dopiero prawdziwy render jest
oznaczony jako „Film”. Brak końcowego pliku daje uczciwy pusty stan, nie atrapę filmu.
„Podgląd techniczny” można pobrać przed odbiorem z takim oznaczeniem; nie jest to
zaakceptowany eksport. Zmiana wyniku unieważnia jego przycisk pobrania jako aktualnego.

Wynik QA nie jest samym zielonym znakiem: „Sprawdzono: napisy, kadry, synchronizację”
tylko jeśli faktycznie wykonano te kontrole. Uwagi prowadzą do fragmentu. Wyczerpanie
pętli QA zatrzymuje pracę, pokazuje zachowany podgląd i konkretny problem. Użytkownik
może zlecić zmianę lub wybrać jawne uproszczenie; nie kliknie „gotowe” przy brakującym
assetcie czy niepoprawnym pliku. Uwaga estetyczna może być świadomie zaakceptowana.

## 4. Sprawdzenie treści i źródeł (UX4)

Treść odcinka jest czytelna jako lista scen, z pełnymi wypowiedziami, nie samymi
tytułami. Wskazanie sceny wybiera właściwy fragment podglądu. Materiał źródłowy
ma osobną etykietę i własny czas, żeby użytkownik nie mylił sekundy źródła z sekundą
wyniku. Przy zdaniu opartym na demonstracji przycisk „Pokaż źródło” otwiera
fragment; dla artykułu pokazuje fragment tekstu. Brak źródeł w zadaniu z samego
tematu nie tworzy pustego panelu dowodów. Nie wymyślamy cytowań dla samego scenariusza.

Przy porównaniu formatu dostępne są „Referencja” i „Nasz podgląd”, bez równoczesnego
autoodtwarzania dźwięku. Porównujemy odpowiadające sobie zdarzenie, nie wymuszamy
identycznego czasu dwóch filmów o różnej długości. Lista uwag może zaznaczyć
„nie odczytano napisu” lub „do sprawdzenia”, zamiast udawać pełną zgodność.

## 5. Koszt i gotowość narzędzi (UX5)

Nowy projekt sprawdza dostęp do potrzebnych narzędzi przed kosztową pracą.
Brak konfiguracji prezentera nie blokuje użycia gotowego nagrania ani samego
podglądu formatu. Pokazujemy „Połącz narzędzie do prezentera” z bezpośrednim
przejściem do właściwej konfiguracji. Klucze pozostają w konfiguracji hosta.
Nie wymagamy konfigurowania wszystkich dostawców na wejściu.

Analiza i tani podgląd też mogą kosztować. Przy pierwszym uruchomieniu użytkownik
wskazuje limit przygotowania; cena nieznana jest tak opisana. Kolejne czynności
w tym limicie nie wymagają akceptacji każdego wywołania. Przed kosztową produkcją
jedna zbiorcza bramka treści i planu zgodnie z propozycją inżynierską.

Zestawienie kosztów rozdziela: „Rozliczono”, „Zarezerwowano na trwającą pracę”,
„Pozostało w limicie”. Szacunek ma osobną etykietę, walutę i czas wyceny. Górnej
granicy nie pokazujemy jako ceny ostatecznej. Zatwierdzenie planu dotyczy jego
wersji; stara karta nie może zatwierdzić nowej pracy po cichu.
Gdy brakuje pewnej górnej granicy, automatyczny tryb ograniczonego budżetu
zatrzymuje operację. Przejście do trybu szacowanego jest osobną, wyraźnie opisaną
decyzją o kosztach, nigdy zwykłym „Dalej”. W szkicu nie ma prawdziwych wycen.

## 6. Rozmowa, zakres korekty i wersje (UX6)

Przy polu „Co poprawić?” zawsze widoczny cel: format albo bieżący odcinek,
ewentualnie zaznaczona scena i element. Domyślnie korekta filmu dotyczy tylko tego
odcinka. „Zapisz jako nową wersję formatu” to oddzielne działanie po podglądzie.
Istniejące odcinki zachowują przypięte wersje; nie zmieniamy całej biblioteki jednym
zdaniem. W edycji formatu wyraźnie pokazujemy „Edytujesz format: … • wersja …”.

Agent przedstawia zmianę przy podglądzie: co zmieni, co pozostawi, co wymaga
ponownego wykonania i jaki jest koszt. Proste odwracalne poprawki podglądu mogą
pojawić się od razu z „Cofnij”; produkcję pokrywają zaakceptowany plan i limit.
Nie dodajemy obowiązkowej bramki każdej wiadomości. Nowa wersja formatu nadal
wymaga właściwej akceptacji. Zmiana wyglądu napisów nie zamawia głosu/prezentera.
Zmiana wypowiedzi pokazuje, że audio, czas i render mogą wymagać przeliczenia.

Lista wersji w szczegółach: data, skrót zmiany, status akceptacji, „Porównaj”
i „Użyj tej wersji jako podstawy”. Powrót tworzy nową rewizję, nie kasuje historii.
Wynik spóźnionej generacji trafia do historii z etykietą „Dotyczy wcześniejszej
wersji”. Nie podmienia filmu oglądanego przez użytkownika.

## 7. Postęp i odzyskiwanie pracy (UX7)

Pokazujemy rzeczywistą pracę: „Używam zapisanego formatu”, „Wybieram fragmenty
podcastu”, „Przygotowuję prezentera”, „Sprawdzam napisy”. Nie pokazujemy nazw modeli
i podgrafów ani fałszywego procentu z czasu. Licznik „2 z 4 materiałów” tylko przy
znanym mianowniku; czas pozostały tylko z wiarygodnego pomiaru.

| Funkcja | Ładowanie | Pusto | Błąd | Sukces | Częściowy wynik |
|---|---|---|---|---|---|
| Projekty / formaty | Zarys wierszy, zachowany nagłówek | Nowy film / Dodaj format | „Nie udało się odczytać listy”, bez utraty projektu | Nazwy, miniatury, stan i wersje | Osobny komunikat przy brakującym podglądzie |
| Dodawanie źródeł | Postęp wysyłania każdego pliku | Dodaj link lub plik; można podać sam temat | Błąd przy pliku, zachowane pozostałe | Edytowalne role i nazwy | Jeden plik niedostępny; wskaż zastępstwo lub usuń z planu |
| Przygotowanie formatu | Stałe miejsce podglądu i opis pracy | Brak referencji/zapisanego formatu | Zachowany ostatni podgląd i uwaga | Oznaczony podgląd + QA | Elementy przykładowe i braki wyróżnione tekstem |
| Treść odcinka | Sceny pojawiają się jako robocze | Podaj temat/scenariusz | Zdanie/scena z uwagą, zachowany tekst | Kompletny scenariusz i źródła | Niepełny scenariusz nie umożliwia produkcji |
| Generacja / render | Faktyczny etap i dostępne anulowanie | „Film jeszcze nie powstał” | Konkretna operacja, zachowane assety | Film gotowy do sprawdzenia | Gotowe assety dostępne, render jeszcze niegotowy |
| Korekta | Widoczna wysłana prośba i cel | Krótka zachęta „Co poprawić?” | Prośba zachowana; brak pewności wykonania opisany | Nowy podgląd i skrót zmiany | Część uwag poprawiona, reszta wskazana |
| Akceptacja | Przycisk zajęty do potwierdzenia zapisu | Brak kompletnego wyniku = opis powodu | Stara wersja: „Pojawiła się nowsza wersja. Sprawdź zmiany.” | „Zatwierdzono wersję …” | Nie ma częściowej akceptacji pełnego filmu |
| Eksport | Przygotowywanie/pobieranie pliku | Najpierw wymagany wynik | Link do ponownego pobrania istniejącego pliku | Nazwa, wersja i gotowy MP4 | Przerwany transfer nie uruchamia ponownego renderu |

| Sytuacja wymagająca uwagi | Komunikat i działanie |
|---|---|
| Brak materiału | Nazwa elementu i „Dodaj materiał” lub „Zmień plan” |
| Niewystarczający limit | Koszt/rezerwacja, zachowane wyniki, „Zmień zakres” lub jawne „Zwiększ limit” |
| Nieznany stan płatnego zlecenia | „Sprawdzamy, czy zlecenie zostało przyjęte”; rezerwacja pozostaje. „Sprawdź zlecenie”, bez ślepego retry |
| Anulowanie | Najpierw „Przyjęto prośbę”, następnie „Zatrzymano nowe zlecenia”; osobno trwające operacje i możliwy koszt |
| Utrata połączenia | „Brak połączenia z aplikacją”; ostatni stan z czasem odczytu. Zamknięcie karty nie anuluje workera |
| Awaria lokalnego procesu | Po powrocie odtworzony stan, nie wymóg ponownego dodania linków |
| Pełny dysk / niezapisany wynik | „Brak miejsca na zapis”; wstrzymanie pracy, ścieżka ustawień magazynu |
| QA nie osiągnęło celu | Ostatni podgląd, problem i działania: poprawka, zmiana zakresu, zakończenie pracy |

## 8. Wygląd, małe ekrany i dostępność (UX8, UX9)

Root DESIGN.md opisuje produkt i historię, a nie normatywny system wizualny.
Nie przepisujemy go na system UI ani nie kopiujemy całego stylu OmniWatcha.
Proponowane tokeny samodzielnego studia: IBM Plex Sans dostarczony z aplikacją,
tekst 16/24 px, etykiety pomocnicze min. 13 px, nagłówki 20/26 i 24/30 px,
odstępy 4/8/12/16/24/32, narożniki 6 px kontrolki i 10 px okna, jedna barwa akcentu.
W Agent OS mapowanie tokenów do hosta, z pomiarem czytelności. Font fallback jest
awaryjny, nie założenie, że na komputerze użytkownika zainstalowano font.

| Token | Jasny | Ciemny |
|---|---|---|
| background | #F7F8FA | #191B20 |
| surface | #FFFFFF | #21242B |
| text | #1C2634 | #EDF0F6 |
| secondaryText | #536176 | #B5BECD |
| border | #D7DDE5 | #454D5A |
| accent / onAccent | #2453BD / #FFFFFF | #ACBEFF / #142649 |

Wygląd dopasowany do preferencji systemu/hosta: przeglądanie treści w jasnym
otoczeniu i ocenianie wideo wieczorem wymagają obu wariantów. Wybór nie wynika
z etykiety „narzędzie AI”. Bez dekoracyjnych kart, gradientów, statystyk i avatarów.
Sygnał stanu ma tekst/ikonę, nie sam kolor. Film pozostaje w swoich proporcjach.
Animacja UI tylko dla zmiany zaznaczenia/podglądu, bez wymuszania autoplay;
„Odtwórz”/„Pauza” steruje ruchem formatu. Respektujemy ograniczenie ruchu.

| Szerokość / sytuacja | Układ |
|---|---|
| ≥ 1100 px | Nawigacja, podgląd i panel treści/korekt obok; bez drugiego dashboardu |
| 768–1099 px | Nawigacja w górnym wierszu; podgląd + panel, jeśli oba pozostają czytelne |
| 320–767 px | Jedna aktywna powierzchnia: Podgląd albo Treść i poprawki. Widoczny przełącznik, zachowany czas i draft rozmowy |
| Otwarta klawiatura / powiększenie | Formularz przewija się normalnie; główne działanie osiągalne, bez zasłaniania treści przyklejonym paskiem |

Czytelność i obsługa pozostają wymaganiem POC: klawiatura do wszystkich działań,
widoczny fokus i etykiety, nazwy ikon, komunikaty stanu dla czytnika, zachowanie
fokusu po aktualizacji, powrót do przycisku po zamknięciu panelu, natywne sterowanie
odtwarzaczem i tekstowa lista scen jako alternatywa dla osi czasu. Brak poziomego
przewijania przy 320 px; pełne nazwy dostępne bez hovera. Wejścia przyjmują polskie
znaki, długie linki i nazwy; RTL w treści obsługiwane przez kierunek automatyczny.

Kontrast tekstu zwykłego min. 4,5:1, dużego min. 3:1 zgodnie z
[WCAG 2.2 — kontrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
Cel projektu to aktywny obszar kontroli min. 44×44 px, zwłaszcza na dotyku;
to surowszy cel projektowy niż minimum 24×24 px z wyjątkami w
[WCAG 2.2 — rozmiar celu](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
Stany asynchroniczne ogłaszamy bez przenoszenia fokusu, zgodnie z
[WCAG — komunikaty stanu](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).
Realny pomiar kontrastu, obsługa VoiceOver i klawiatury wymagają odbioru implementacji.

## 9. Co wykorzystujemy, a co odkładamy

Wykorzystujemy model źródła przypiętego do wyniku, wybór fragmentu przez timestamp,
historię wyników i powrót do źródła z obecnego prototypu. Z dokumentacji konkurencji
bierzemy wymagania zapisania formatu i poprawiania elementów; nie kopiujemy UI
ani nie deklarujemy nowego audytu aktualnych usług. Istniejąca nawigacja i sesja
Agent OS zostają granicą integracji, nie drugim produktem projektowanym od zera.

NOT in scope:
- Ręczny edytor wszystkich ścieżek/klatek typu NLE: obecny cel to praca z agentem,
  wybór fragmentu i poprawki; nie projektujemy Premiere.
- Marketplace formatów, współpraca zespołowa i marketing: nie są potrzebne do POC.
- Płatności i panel wieloużytkownikowego clouda: osobny etap wskazany w TECHNICAL.
- Przebudowa UI OmniWatcha/Agent OS: projekt dotyczy studia i cienkiej integracji.

## 10. Szkic i status

Klikalny szkic służy do oceny hierarchii, trzech rodzajów wyniku, ponownego użycia
formatu oraz zakresu korekty. Dane, kwoty i plansza są przykładowe. Nie uruchamia
modeli, nie zapisuje akceptacji projektu i nie przedstawia renderu benchmarku.
Ścieżka źródła szkicu: `/Users/janek/.codex/visualizations/2026/09/22/01a0c965-4e16-7b71-9ea9-860fe8299e52/studio-praca-nad-filmem.html`.
Generator PNG GStacka niedostępny; szkic inline korzysta z dozwolonego katalogu
tego zadania. To nie zatwierdzona makieta finalnej warstwy graficznej.

Raport siedmiu przebiegów: [DESIGN-REVIEW](DESIGN-REVIEW.md).
