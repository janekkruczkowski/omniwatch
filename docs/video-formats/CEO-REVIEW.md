# Przegląd produktowy gstack — w toku

2026-09-22. Zastosowany skill: `plan-ceo-review` z lokalnej instalacji gstack.
Dokument przeglądany: [CONCEPT.md](CONCEPT.md). To początek przeglądu założeń,
nie wynik pełnych jedenastu sekcji ani zgoda na implementację.

Preferencja Jana ma pierwszeństwo nad pytaniem o każdą opcję w skillu:
przygotowujemy autonomicznie rekomendacje i zbieramy je do akceptacji całości.
Robocza postawa: HOLD SCOPE względem scenariuszy opisanych przez użytkownika.
Nie dodajemy nowych funkcji; etapowanie dostawy nie usuwa scenariuszy z wizji.

## Problem i rezultat

Rezultatem jest gotowy własny film, który wymaga od użytkownika oceny i korekt
twórczych, a nie ręcznego koordynowania narzędzi. Podobieństwo pojedynczej klatki
do referencji jest pomocniczym pomiarem, nie główną miarą użyteczności.
Bez uporządkowania etapów zostają działające fragmenty i ręczne przenoszenie
informacji między nimi. Rozmiar realnej oszczędności czasu jest jeszcze niezmierzony.

Obecnie: Director i bogatszy prototyp formatów → proponowana zmiana: wspólny
projekt, opis montażu, etapy z QA i akceptacjami → kierunek docelowy: wielokrotna
produkcja różnych filmów z własnych oraz generowanych materiałów i zapisanych formatów.

## Alternatywy struktury

| Podejście | Zalety | Wady | Wykorzystanie istniejącej pracy | Nakład / ryzyko |
|---|---|---|---|---|
| A. Dopiąć scenariusze do obecnego Directora | Najmniejsza reorganizacja; szybkie użycie istniejącego UI i providerów | Utrwala rozdział dwóch mechanizmów formatów; wspólny stan i korekty nadal wymagają zaprojektowania | Brief, produkcja, render i ekran Directora | M / wysokie przy poszerzaniu scenariuszy |
| B. Wspólny graf i moduły, wydzielane etapami | Jedna reprezentacja pracy; ponowne użycie pomiarów i renderu; niezależny rozwój strategii | Wymaga kontraktów i migracji integracji; pierwszy etap sam nie produkuje pełnego filmu | Istniejące biblioteki jako narzędzia etapów, obecne UI jako pierwsza powierzchnia | L / średnie |
| C. Nowy silnik studia od początku | Swoboda modelu projektu; jednolite granice od startu | Powiela sprawdzoną pracę; dłuższa droga do porównywalnego wyniku i większe ryzyko regresji | Głównie materiały ewaluacyjne i integracje dostawców | XL / wysokie |

Rekomendacja robocza: B. Najlepiej odpowiada żądanej dekompozycji i wykorzystuje
istniejące instrumenty. Nie oznacza wyboru frameworka grafu ani zgody na przepisanie
całości. Oceny nakładu są względne; kalendarz dla zespołu lub agentów wymaga planu technicznego.

## Pierwsze rozstrzygnięcia do rozwinięcia

1. Format i materiał odcinka mają niezależne źródła. Ich mylenie ogranicza narzędzie
   do podmiany elementów w referencji i nie obsłuży własnego nagrania.
2. Tani podgląd sprawdza zachowanie formatu, a pełny render i QA sprawdzają film.
   Pierwsza akceptacja nie zwalnia z kontroli jakości po dodaniu rzeczywistych materiałów.
3. Skorygowana przez użytkownika kolejność: istniejący benchmark Hypit i tanie
   evale, podcast z rzeczywistego materiału, potem pełny film Qwen w formacie
   shorta Juliana. Wycofana propozycja rozpoczynania od nagrania Jana.
   Podgląd i zapis formatu mają własny odbiór; pełna integracja kończy się MP4.
4. Poprawka powinna wracać do odpowiedniego etapu. Wymiana jednej grafiki nie
   uzasadnia ponownej analizy całego źródła ani generowania wszystkich elementów.
5. Kontrola recenzenta wymaga osobnego kontekstu i dowodów; dodatkowy agent
   nie gwarantuje jakości bez konkretnych kryteriów oceny.

Do dalszego przeglądu: dokładny kontrakt dopasowania formatu do nowych czasów,
zakres bramek treści/kosztu, kryteria odbioru pełnego filmu i zachowanie przy korektach.
Nie wykonano jeszcze przeglądu inżynierskiego ani zewnętrznej recenzji tego konceptu.

Preambuła skilla działa; aktywna nakładka instrukcji dla modelu gpt-6-astra.
Zapis pomocniczego znacznika odkrycia tej funkcji w `~/.gstack` odmówiony przez
sandbox (Operation not permitted). Nie blokuje czytania skilla ani pracy nad koncepcją.
