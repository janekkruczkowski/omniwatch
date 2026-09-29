# Pipeline jako graf z bramkami — plan

**Data:** 2026-09-22 · **Podstawa:** dzień pracy, w którym **każda** naprawa miała ten sam kształt.

---

## 0. Dlaczego graf, a nie „bo teraz tak się robi"

Nie zaczynam od LangGrafa. Zaczynam od obserwacji, że wszystko, co dziś naprawiliśmy, było
jednym z dwóch przypadków:

**Etap, który już sprawdza swój wynik i próbuje inaczej.** Skan planszy przechodzi osiem
klatek, bo ta jedna wybrana przez model bywa zasłonięta. Wyszukiwanie sufitu napisów mierzy
się z rytmem policzonym z filmu. Pomiar insertów chodzi po całym spanie i grupuje po
pokryciu pudełek. Generowanie obrazka ponawia raz po odmowie dostawcy. Cztery bramki, każda
napisana ręcznie, każda w innym stylu, żadna nie wie o istnieniu pozostałych.

**Etap, który NIE sprawdza swojego wyniku — i dlatego cicho kłamie.** Pasmo napisów jest
lokalizowane przez model. Gdy model nie odpowie, zostaje zgadywana wartość z capture i nikt
tego nie zauważa: napis ląduje 3 punkty procentowe niżej, w środku planszy zamiast na jej
krawędzi. Zmierzone 52,76%, użyte 56%. **To jest błąd, który Janek zobaczył gołym okiem na
klatce, a pipeline przeszedł bez jednej notatki.**

Graf nie jest tu modą. Jest nazwaniem tego, co już robimy w czterech miejscach, żeby dało się
zrobić to w piątym, szóstym i siódmym — i żeby brak bramki był **widoczny**, a nie domyślny.

---

## 1. Trzy reguły, którym musi podlegać każdy węzeł

Te reguły są wyciągnięte z konkretnych awarii, nie z podręcznika.

**1. Węzeł deklaruje, co znaczy, że mu się udało.** Nie „nie rzucił wyjątku" — konkretny
warunek na wyniku. *Skan planszy:* znalazłem siatkę o co najmniej trzech rzędach. *Pasmo
napisów:* mam pudełko zmierzone z pikseli, nie odziedziczone z wejścia. *Aligner:* liczba słów
jest niezerowa i pokrywa większość czasu filmu.

**2. Wynik, który nie przeszedł bramki, jest DZIURĄ, nie wartością domyślną.** Dzisiejsza
awaria wzięła się stąd, że nieudana lokalizacja wyglądała identycznie jak udana — zostawała
wartość z wejścia. Węzeł ma zwrócić „nie wiem", a nie po cichu cudzy domysł.

**3. Ponowienie zmienia WEJŚCIE, nie prompt.** Skan planszy nie pyta modelu drugi raz tymi
samymi słowami — patrzy na inną klatkę. To jest różnica między pętlą, która zbiega, a pętlą,
która płaci dwa razy za ten sam błąd.

---

## 2. Węzły, bramki i co robić po nieudanej bramce

| węzeł | daje | bramka | gdy nie przejdzie |
|---|---|---|---|
| **źródło** | plik, długość, wymiary | plik się dekoduje | stop, to nie jest film |
| **słowa** | czasy słów | ≥ 1 słowo i pokrycie czasu > 50% | dalej bez zegara, napisy zostają jak zobaczone |
| **lokalizacja regionów** | pudełka z modelu | *brak* — to tylko podpowiedź | — |
| **skan planszy** | siatka rzędów | ≥ 3 rzędy, równa wysokość i rozstaw | **przejdź kolejne klatki**; po ósmej: film bez planszy |
| **pasmo napisów** | pudełko + rozmiar liter | pudełko **zmierzone**, nie z wejścia | **inna klatka**; potem: skan tuszu; potem: dziura |
| **rytm napisów** | ile porcji | liczba zmian ≥ 2 | tnij szerokością pasma |
| **cięcie napisów** | porcje | liczba porcji w granicach zmierzonego rytmu | przeszukaj sufit ponownie |
| **inserty** | pudełka i czasy | każdy insert ma pudełko albo jest jawnie odrzucony | warstwa insertów znika **z notatką** |
| **assety** | obrazki | każdy slot ma plik | jedno ponowienie, potem **widoczna dziura** |
| **kompozycja** | dokument | reguły twarde z §6 kontraktu | stop — to błąd nasz, nie filmu |
| **render** | mp4 | plik istnieje i ma długość | stop |

Kolumna „gdy nie przejdzie" jest tą, której dziś nie ma nigdzie zapisanej. Trzy z tych
zachowań już istnieją w kodzie, rozsiane; reszta to domysły, które trzeba zastąpić decyzją.

---

## 3. Gdzie pętla agenta ma sens, a gdzie jest droższym sposobem na ten sam błąd

**Ma sens tam, gdzie decyzja jest kategoryczna i da się ją sprawdzić.** „Czy ten film ma
planszę?" — agent może obejrzeć trzy klatki i odpowiedzieć, a skan pikselowy **zweryfikuje**
odpowiedź. Jeśli agent mówi „tak", a skan nie znajduje siatki, wygrywa skan i pętla się kończy.

**Nie ma sensu tam, gdzie odpowiedź jest wielkością ciągłą.** Cały dzisiejszy dzień to dowód:
model zapytany o rozmiar captiona odpowiedział 0,028 przy zmierzonym 0,038. Pętla agenta wokół
tego pytania to trzy złe odpowiedzi zamiast jednej.

**Warunek wstępny, bez którego pętli nie wolno dodawać:** każdy węzeł ma bramkę z §2. Pętla
bez warunku akceptacji nie zbiega — ona tylko kosztuje.

---

## 4. LangGraph czy własne

Uczciwie: **nie zaczynałbym od LangGrafa.**

Pipeline jest w TypeScripcie i całą wartość ma w bibliotekach pomiarowych, które są czystymi
funkcjami. LangGraph.js istnieje, ale wnosi model wykonania, stan i słownictwo, których tu
jeszcze nie potrzebujemy — mamy **jedenaście węzłów w prostej sekwencji z ponowieniami**, a nie
rozgałęziony graf z równoległością i checkpointami.

Co naprawdę jest potrzebne, i co da się napisać w jeden wieczór:

```ts
interface Node<In, Out> {
  name: string;
  run(input: In, notes: string[]): Promise<Out | null>;
  /** Czy ten wynik wolno puścić dalej. */
  accepts(out: Out): boolean;
  /** Co zmienić w WEJŚCIU przed kolejną próbą, albo null gdy nie ma czego. */
  retry?(input: In, attempt: number): In | null;
  /** Co zwrócić, gdy nie udało się nigdy: wartość zdegradowana albo null = dziura. */
  onGiveUp(input: In, notes: string[]): Out | null;
}
```

To jest cały mechanizm. Reszta to zapisanie jedenastu węzłów w tym kształcie i **jeden
przebieg = jedna lista notatek**, w której widać, która bramka nie przeszła i przy której
próbie. Dziś tę informację trzeba wyłuskiwać z grepowania logów.

Kiedy wrócić do LangGrafa: gdy pojawi się gałąź „długi film → shorty", bo tam **jest**
rozgałęzienie (klonuj format / tnij i przekadruj), równoległość po kandydatach na short i stan,
który warto checkpointować. Wtedy to będzie wybór z powodu, a nie z rozpędu.

---

## 5. Co zrobić najpierw

1. **Bramka na paśmie napisów** — jedyna dziś brakująca, która realnie psuje obraz. Warunek:
   pudełko zmierzone, nie odziedziczone. Ponowienie: inna klatka.
2. **Wspólny kształt węzła** — przepisać na niego cztery bramki, które już istnieją, bez
   zmiany ich zachowania. Zero nowych możliwości, same widoczne szwy.
3. **Jeden przebieg = jeden raport** — która bramka, która próba, co ostatecznie zwróciła.
   To zastąpi grepowanie i sprawi, że różnica między dwoma przebiegami stanie się czytelna.
4. Dopiero potem pętla agenta, i tylko na pytaniach kategorycznych z §3.

---

## 6. Tanie assety do testów

Rendery i generowanie są najdroższą częścią pętli, a **żadne z nich nie odpowiada na pytanie,
czy format wyszedł dobrze**. Stąd:

- `scripts/make-plate.mjs` — płyta zastępcza dla prowadzącego: jedna klatka z najcichszego
  momentu filmu, przycięta do tego pasa, w który klon niczego sam nie rysuje, trzymana przez
  całą długość, z oryginalnym dźwiękiem pod spodem. Jedno ffmpeg, zero kredytów.
- `clone-film.mjs --mock-host` — to samo, ale okno przycięcia liczone z **regionów zmierzonych
  w tym przebiegu**, więc płyta nie niesie cudzego banera ani cudzych napisów.
- `clone-film.mjs --still` — w ogóle nie pytaj dostawcy o obrazki; narysuj puste pudełka.

Pierwsza wersja płyty nie przycinała nic i przyniosła napis oryginału, na którym klon narysował
swój — dwie linijki przechodzące przez siebie. Druga przycinała wszystko, co zachodzi na
prowadzącego, i zostawiła sam podbródek. Blokuje dopiero to, co idzie **przez szerokość** kadru.

---

## 7. Skan tuszu — trzeci krok bramki na paśmie, zmierzony

**Data pomiaru:** 2026-09-22. Wszystkie liczby niżej są policzone z filmów w cache, bez
jednego zapytania do modelu.

§2 wymienia dla pasma napisów trzy kroki po nieudanej bramce: *inna klatka → skan tuszu →
dziura*. Środkowy nie istniał. Okazuje się, że jest jednocześnie najtańszy i najważniejszy.

### Licznik rytmu nie jest zepsuty — pasmo jest

| film | pasmo | policzone kwestie | prawda |
|---|---|---|---|
| ranking | zmierzone `[0.04, 0.5276, 0.92, 0.0447]` | 26 | 24 |
| ranking | zgadnięte `y=0.72` | **12** | 24 |
| wywiad | zgadnięte przez capture `y=0.72` | 25 | 45 |
| wywiad | tam, gdzie wskazują piksele `y≈0.58` | 39 | 45 |

Dokładność ±8% przy zmierzonym paśmie, **połowa** przy zgadniętym. Wywiad jest najsłabszym
przypadkiem nie dlatego, że jest trudniejszy, tylko dlatego, że jego pasmo nigdy nie zostało
zmierzone. To ta sama awaria co w §0, widziana od strony rytmu zamiast od strony klatki.

### Pasmo da się znaleźć bez modelu

Zmienność w czasie liczona wiersz po wierszu (cała klatka do 32×64 szarości, 10 kl./s, suma
różnic sąsiednich klatek) daje na rankingu pik na `y=0.516–0.562`. Zmierzone pasmo to
`0.528–0.572`. **Skan pikselowy odtwarza odpowiedź modelu jednym wywołaniem ffmpeg.**

Warunek, którego nie wolno pominąć: na wywiadzie piku nie ma, bo to ujęcie z ręki i rusza się
cały kadr. Skan musi więc porównywać pas z **ruchem samej klatki**, a nie z zerem — różnica
między „kadr się rusza" a „ten pas jest przerysowywany".

### Dwie hipotezy odrzucone, żeby nikt nie próbował drugi raz

- **Przerwy nie stoją w pauzach mowy.** Na wywiadzie przerwa w miejscu cięcia ma medianę
  0,060 s, a wewnątrz kwestii 0,080 s. Cięcie po pauzach byłoby gorsze niż losowe.
- **Próg „linia przerysowana" nie powinien być liczony względem zapisanej szerokości pasma.**
  We wszystkich trzech filmach świecą się 96 kolumny na 96 — normalizacja nie zmienia nic.
- **„Patrz szybciej, aż przestanie się ruszać" nie zbiega.** Ranking przy 10/20/30/40 kl./s
  daje 26, 28, 26, 27, ale przy 60 skacze na 33: przy tej gęstości szum i znacznik karaoke
  zaczynają się liczyć jako zmiana kwestii. `BAND_FPS = 10` jest w porządku; to nie była
  przyczyna.

### Uzupełnienie po zbudowaniu skanu (2026-09-22, wieczór)

Skan tuszu istnieje i jest **uczciwy**, ale nie robi tego, po co powstał.

- **Ranking:** trafia w wiersz, nie w pudełko — `[0.156, 0.516, 0.844, 0.094]` wobec zmierzonego
  `[0.04, 0.528, 0.92, 0.045]`. Dwa razy za wysokie, przycięte po bokach. Przy rastrze 32×64
  jeden wiersz to 1,6% wysokości, a pasmo ma 4,5%; rozdzielczość tłumaczy cały błąd.
- **Wywiad:** zwraca **dziurę** z notatką „nic się nie wyróżnia". Zgodnie z regułą 2 — i
  jednocześnie znaczy, że przypadku, dla którego powstał, nie ratuje.

**Trzecia odrzucona hipoteza: zgodność z alignerem nie wskazuje pasma.** Pomysł był taki, że
napis zmienia się na granicach słów, a kamera nie. Mediana odległości zmiany pasma od
najbliższego początku słowa wynosi **0,060 s niezależnie od tego, gdzie postawić pasmo**
(wywiad, siedem pozycji od 0,45 do 0,80). Nic nie różnicuje. Najniższe wartości wypadają przy
pasmach, które mają dwie zmiany na cały film — czyli tam, gdzie sygnału nie ma wcale.

**Pozytywny produkt uboczny, wart zapamiętania:** na rankingu **sama liczba kwestii jest
ostro zlokalizowana**. Przemiatanie pasma w dół kadru daje 26 kwestii przy `y=0.50`, 22 przy
`y=0.53` i **od 1 do 11 wszędzie indziej**. Prawdziwe pasmo siedzi w tym wąskim piku. Na
wywiadzie piku nie ma — wszędzie wychodzi 28–39. To jest niezależne potwierdzenie, że odmowa
skanu na wywiadzie jest **słuszna, a nie leniwa**.

**Wniosek, który przestawia problem:** różnica na wywiadzie nie jest kwestią *położenia*
pasma. Nawet najlepsze przemiecione pasmo daje 39 wobec ich 45, a capture'owe 0.72 daje 32 —
przy czym nie ma zasady, która pozwoliłaby wybrać to lepsze inaczej niż przez dopasowanie do
znanej odpowiedzi, czego nie robimy. Zostaje hipoteza o **scalaniu sąsiednich zmian**: przy
medianie trwania kwestii 0,34 s i dziesiątym percentylu 0,08 s detektor zbocza narastającego
liczy dwie sąsiednie zmiany jako jedną. To jest następny trop, i **nie jest sprawdzony**.
