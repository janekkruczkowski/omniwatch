# OmniWatch — dokument projektowy

> Stan: do decyzji. Powstał z rozmowy 2026-09-20, po dwóch dniach budowania rzeczy,
> których nie umieliśmy wytłumaczyć. Bez kodu. Kod dopiero pod zatwierdzoną wersją.

---

## 1. Czym to jest

**Wideo to ta część internetu, której agent nie umie przeczytać.** Strony, dokumenty,
posty na X — to wszystko Hermes czyta. Wideo jest dla niego nieprzezroczyste.
OmniWatch daje mu oczy.

To jest **zdolność, nie zakładka**. Jedna zdolność wpięta w kilka miejsc, a nie jeden produkt.

---

## 2. Reguła: kiedy oglądanie bije transkrypt

Transkrypt jest zawsze tańszy i w wielu niszach wystarcza. Decyzja **nie jest o koszcie
(patrz §3), tylko o dziedzinie**. Oglądaj, kiedy przekaz jest w obrazie. Trzy znaki:

1. **Nie ma ścieżki mówionej.** Film niemy, muzyka, napisy na ekranie. Transkryptu fizycznie nie ma.
2. **Informacja jest wizualna.** Zestawienia kolorów, tabela z pomiarem, wykres, ekran aplikacji,
   kroki wyklikane w interfejsie, ćwiczenie pokazane ciałem.
3. **Mechanizmem jest czas.** Długość hooka, moment cięcia, sekunda pojawienia się produktu.

Przypadek negatywny, nazwany wprost: **gadająca głowa tłumacząca temat.** Taki film *jest*
swoim transkryptem. Dwa dni robiliśmy demo na filmach Juliana, czyli na najgorszym
możliwym materiale dla tego narzędzia. To tłumaczy, dlaczego na pytanie „co daje
obejrzenie" nie było dobrej odpowiedzi.

### Dowód, że ta reguła nie jest teoretyczna

**a0) Test A/B przeciw grupie kontrolnej — 2026-09-20, rozstrzygający.**
Film `Fz89dJTZsko` „Everything That Burns More Fat Than Jogging" (21:26, 4 mln wyświetleń),
wybrany dlatego, że **ma już notatkę z transkryptu** w `raw/transcripts/` i zasila dwie strony
pojęciowe. Czyli istnieje grupa kontrolna.

To był **trudny** przypadek, nie łatwy: Jeremy wypowiada większość liczb na głos,
więc transkrypt (3919 słów) zawiera ich sporo. Ale urywa się dokładnie w trzech miejscach:
*„here's all the raw data"*, *„here's how I ended up ranking them"* i *„this study…"*.

Co dołożyło obejrzenie (**540 225 tokenów, 173 s, ~8,1 centa**):

- **Pełna tabela surowych danych [19:27]**, dwie sztuki (Jeremy i Dennis), kolumny
  EXERCISE | Duration | Calorie Burn | Calories/Minute | Carb vs Fat Burn, po 12 wierszy.
  To **96 komórek**. Transkrypt zawiera z nich jakieś 25, rozrzuconych po 4 tysiącach słów
  wraz z żartami o Dennisie. Kolumny `Calories/Minute` i `Carb vs Fat` dla wszystkich
  dwunastu aktywności nie padają w narracji prawie wcale.
- **Oba rankingi końcowe w całości** — 24 pozycje. Z narracji da się wyłuskać cztery
  (najlepsze i najgorsze każdego z nich).
- **Cytowanie badania [16:45]**, którego w transkrypcie nie ma w ogóle: *Exercise Medicine*,
  DOI `10.26644/em.2018.008`, „Caloric Expenditure Estimation Differences between an
  Elliptical Machine and Indirect Calorimetry", A. Page Glave, Jennifer J. Didier,
  Gary L. Oden, Matthew C. Wagner, n = 20. Transkrypt mówi w tym miejscu tylko, że maszyny
  mylą się „o 10 do 30%".
- Post Dwayne'a Johnsona ze zrzutu [16:06], słupki porównawcze [15:23, 15:45],
  odczyt maszyny kontra odczyt maski [16:34].

**Kontrola na zmyślanie — trzy niezależne sprawdzenia, wszystkie przeszły:**
1. *Zgodność z narracją.* Każda liczba wypowiedziana w filmie zgadza się z komórką odczytaną
   z tabeli (146/69 skakanka, 178/148 sprinty, 350/260 jogging, 276/223 pływanie,
   223→256 i 190→215 stairmaster, 97%/3% sprinty, 80% marsz).
2. *Spójność arytmetyczna.* 146 kcal / 10 min = 14,6 kcal/min, i tak dla wszystkich wierszy.
3. *Weryfikacja zewnętrzna.* Odpytanie rejestru DOI zwróciło ten sam tytuł, to samo
   czasopismo, rok 2018 i **wszystkich czterech autorów w tej samej kolejności**.
   Model odczytał zrzut artykułu naukowego z klatki filmu bezbłędnie.

Model sam zaznaczył trzy rzeczy, których w tabelach nie ma (m.in. strefy tętna per aktywność),
zamiast je dopowiedzieć.

**Wniosek:** reguła z §2 broni się nawet na przypadku, który miał ją obalić. Dla Twojego wiki
oznacza to, że 299 notatek z transkryptów ma systematyczną dziurę dokładnie tam, gdzie kanał
pokazuje wynik zamiast go czytać. A strona `jak-kanal-cytuje-badania.md` istnieje
i nie ma czym jej karmić, bo cytowania są na slajdach.

**a) Vault, Built With Science.** W `Wiki/built-with-science/` stoi kompletne wiki zbudowane
z **299 transkryptów** z 313 filmów Jeremy'ego Ethiera. Czternaście filmów nie ma transkryptu
w ogóle. Ale ważniejsze jest co innego: schemat tego wiki sam rozróżnia „utlenianie tłuszczu
(mierzone w laboratorium)" od „utraty tkanki tłuszczowej". W kanale o **pomiarach** pomiary
są na ekranie. Film „I Proved People Have NO Idea How Many Calories They Eat" (28:46,
4,2 mln wyświetleń) to eksperyment, którego wynikiem jest tabela. Transkrypt mówi w tym
miejscu „as you can see here".

**b) Test na żywo — przeprowadzony 2026-09-20.** Film Qwena na X
(`2086664887560970531`), 247 sekund:

```
subs      : BRAK
auto-subs : BRAK
```

Z warstwy tekstowej zostaje slogan z tweeta: *„turn your favorite agent harness
multimodal-native"*. Cztery minuty demo produktu są niewidoczne dla każdego narzędzia
w Agent OS poza tym jednym.

OmniWatch na tym samym filmie: **59 303 tokeny, 95 sekund, ~0,9 centa**. Wyciągnął m.in.
nazwy wtyczek (`core`, `video-memory`, `video-edit`, blender+freecad, edu-agent),
pięciostopniowy pipeline pamięci wideo z indeksowaniem wektorowym i grafem relacji postaci,
modelowanie 3D natywne dla Blendera z dialogiem autokorekty („the TV's back faces the living
room — I'll flip the TV 180°"), generowanie lekcji z sfotografowanej kartki z zadaniem
z biologii, ścieżki montażowe V1/B1/CC/FX w QwenPaw Creator, oraz **adres repozytorium
i listę wspieranych harnessów: Claude Code, Openclaw, Codex, Qoder**.

Model sam oznaczył, czego nie jest pewien („some small UI details are too dense or partially
obscured to transcribe fully"), co potwierdza sensowność pola pewności z §5.

**Weryfikacja odczytu:** `github.com/QwenLM/Qwen-MM-Plugins` istnieje — *„Make any agent
harness multimodal-native"*, 2934 gwiazdki, utworzone 2026-07-29, ostatni push 2026-09-20.
Model odczytał adres poprawnie z niemego filmu. Co to dla nas znaczy: §8a.

---

## 3. Koszty — zmierzone, nie szacowane

Qwen: **0,15 $ / mln tokenów wejścia**, 0,47 $ / mln wyjścia.
Film generuje ~350 tokenów na sekundę materiału przy 2 kl/s (10 kl/s dla ≤3 min).

| co | ile |
|---|---|
| short / TikTok / Reel | **~1 cent** |
| film 9 min (mediana Juliana) | **~2,8 centa** |
| kurs 65 min | **~20 centów** |
| 30 ostatnich filmów Juliana (5 h 47 min) | **1,09 $** |
| cała warstwa A Jeremy'ego Ethiera (74 filmy) | **~4,40 $** |
| poranny digest, 5 kanałów × 2 filmy dziennie | **~9 $ / mies.** |

**Wniosek, który obala wcześniejsze rozumowanie:** twierdziłem, że przelot przez kanał to
„kilka do kilkunastu dolarów" i na tym zbudowałem argumentację za eskalacją i za wycinaniem
crona. Pomyliłem się o rząd wielkości. Przy tych cenach koszt **przestaje być kryterium**.
Zostaje wyłącznie reguła z §2.

Ograniczenie techniczne: sufit ~40 min na jedno żądanie. Dłuższe idą na części (mechanizm istnieje).

---

## 3a. Gdzie to siedzi w Agent OS — audyt istniejących zakładek

Cel nadrzędny: **produkt dla społeczności Juliana**, bo jego udostępnienie i zasięg
są kanałem dotarcia. Nie budujemy pod prywatny Vault jednej osoby.

Cztery zakładki wideo i żadna się z nami nie dubluje:

| zakładka | co robi | wejście |
|---|---|---|
| `/video` Video Studio | temat → scenariusz → ElevenLabs → awatar HeyGen → B-roll → montaż | brak materiału |
| `/openmontage` | prompt → film kinowy (`movie_om.py` Veo 3.1 ~2-3 $, `cinematic_om.py` ~0,30 $) | brak materiału |
| `/video-use` Video Editor | wrzucasz film + polecenie → `edit/final.mp4`, pod spodem Claude Code ze skillem video-use | **istniejący materiał** |
| `/omniwatch` | rozumie film | **istniejący materiał** |

**Luka jest na styku dwóch ostatnich.** Video Editor dostaje polecenie po ludzku
(„wytnij nudne fragmenty"), ale nie wie, co jest w filmie — to agent z ffmpegiem,
który zgaduje. OmniWatch wie, sekunda po sekundzie. **Nasze wyjście jest instrukcją,
której Video Editorowi brakuje.** To nie dublowanie, to brakujące wejście.

### Reguła umiejscowienia
**Na żądanie → zakładka boczna `/omniwatch`. Cyklicznie → Hermes** (tam jest scheduler).
Decyduje wyzwalacz, nie liczba filmów: jednorazowy skan całego kanału zostaje w zakładce
bocznej, codzienny digest jednego kanału idzie do Hermesa.

### Pamięć
Konwencja Vaulta **Agent OS-a** (`logToVault`, tak jak pozostałe zakładki), nie autorski
schemat z czyjegoś prywatnego wiki. Wiki Built With Science z §2a jest **dowodem
i przykładem**, nie specyfikacją wyjścia.

---

## 3b. Skan kanału na żądanie — implementacja

To trzeci tryb istniejącej zakładki `/omniwatch`, obok Teardown i Ask — nie nowa zakładka.
Rozstrzyga to reguła z §3a: skan, który odpalasz sam, zostaje w zakładce bocznej; skany
cykliczne należą do Hermesa, bo tam siedzi harmonogram.

Dwa naciśnięcia, nie jedno. Pierwsze tylko wypisuje konto i **jest darmowe** — yt-dlp i tak
zna uploady kanału, liczbę wyświetleń i długości, więc wyliczenie nic nie kosztuje. Dopiero
drugie wydaje pieniądze. Listę z ceną przy każdym filmie i sumą na dole widzisz, zanim
cokolwiek się pobierze. Powód jest prosty: kanał to pierwszy moment, w którym to narzędzie
prosi o więcej niż kilka centów, a kwota, której nikt się nie spodziewał, to sposób, w jaki
narzędzie traci człowieka.

**Bez sufitu na liczbie filmów.** Opcja ALL czyta całe konto, ile by go nie było. Zmierzone
na kanale Juliana Goldiego: **6873 filmy**, szacunek **$292,44** — wobec trzydziestu, które
pokazałby stary limit. Nazywanie trzydziestki „całym kanałem" było po prostu nieprawdą.
Chroni tu cena i potwierdzenie, którego żąda, a nie sufit wybrany za kogoś: powyżej $2, albo
gdy któryś film nie ma znanej ceny, przycisk trzeba nacisnąć dwa razy, a za drugim razem
mówi wprost „Yes — spend $X". Listy dłuższe niż 30 pozycji przychodzą z niczym zaznaczonym,
bo odhaczenie 6873 wierszy otwierałoby ekran z setkami dolarów już wybranymi. Jeden skan
przyjmuje najwyżej 500 filmów jako zabezpieczenie po stronie serwera i ekran mówi o tym
przed wyborem, nie po nim.

**Pokrycie platform, zmierzone 2026-09-20:**

- **YouTube** — lokalnie przez yt-dlp. `youtube.com/@JulianGoldieSEO` zwrócił 424 000
  subskrybentów i listę z zakładek uploads i shorts, z wyświetleniami i długościami.
- **TikTok** — też lokalnie przez yt-dlp. `tiktok.com/@zachking`: płaska lista podaje
  `view_count`, `like_count`, `duration` i `timestamp`.
- **Instagram** — nie działa. yt-dlp sam oznacza swój ekstraktor profilu jako zepsuty i bez
  ciasteczek pada. Instagram idzie więc ścieżką Apify przez Hermesa, tą samą co Scout, i
  ekran mówi wprost, że to kosztuje — zamiast powtarzać obietnicę darmowego listowania tuż
  przed opłatą. Apify zwraca 25 najnowszych, więc to nigdy nie jest całe konto.

**Luka, którą trzeba było obsłużyć.** Zakładka Shorts nie podaje w ogóle długości (sprawdzone).
Shorty to materiał, który to narzędzie czyta najlepiej, więc nie mogły wszystkie zostać bez
ceny. YouTube sam ogranicza short do trzech minut, więc ten sufit jest ceną — pokazywaną jako
sufit (`≤$0,047`), nie jako kwota. Mylenie się w górę to jedyny bezpieczny kierunek.

**Kalibracja wyceny: 170 tokenów na klatkę**, nie ~120, bo model płaci również za ścieżkę
dźwiękową. Ta liczba odtwarza przebiegi zmierzone w §3: dziewięciominutowy film wychodzi
$0,029 przy zmierzonych 2,8 centa, a 65-minutowy kurs ląduje koło dwudziestu centów, tak jak
zmierzono. Test na żywo: pięć najczęściej oglądanych filmów Juliana to $0,08 razem.

**Historia skanów.** Kopia w Vaulcie jest dla agentów — to proza w datowanym pliku, i szukanie
w niej tego, co się odpaliło w zeszłym tygodniu, oznaczało grzebanie po Obsidianie. Każdy skan
leży więc także w całości na dysku, jako JSON w `~/.agentic-os/omniwatch/channels/`, a zakładka
wypisuje je pod „Scans you have run": konto, temat, liczba filmów, data i faktyczny koszt.
Otwarcie jednego jest darmowe — wraca z dysku, nie jest oglądane drugi raz — i pisze „spent
when this ran", zamiast udawać świeży wydatek. Sprawdzone od początku do końca: skan zapisany,
wylistowany i odtworzony z nietkniętym teardownem na 18 178 znaków.

**Zapis pamięci** bez zmian względem reguły z §3a: `logToVault`, folder `OmniWatch Channels`,
jeden datowany plik dziennie, jedna sekcja na film.

**Porządek:** najpopularniejsze albo najnowsze. Najpopularniejsze czyta 60 uploadów w głąb
przed sortowaniem, bo „najpopularniejsze" nic nie znaczy, jeśli widać tylko ostatnią garstkę.

**Przegląd kodu.** Audyt nowego kodu znalazł cztery prawdziwe defekty; wszystkie naprawione.
Dwa ważyły najwięcej. Po pierwsze, **wycena mogła wyjść poniżej faktycznego rachunku** na
granicy trzech minut, gdzie próbkowanie spada z 10 do 2 klatek na sekundę: film wypisany jako
181-sekundowy, a zmierzony na 180, był wyceniany na $0,0099, a rozliczony na $0,0466 — 4,7
raza za mało. Teraz wszystko w promieniu pięciu sekund od tej granicy wycenia się po drogiej
stronie. To był najpoważniejszy z nich, bo nie zaniżać rachunku jest całą obietnicą tej
funkcji. Po drugie, **zadanie wciąż działające było usuwane** z pamięci po godzinie, bo
czyszczenie patrzyło na czas startu, gdy nie było czasu końca: skan dłuższy niż godzina
kasował sam siebie własnym odpytaniem, mówił zakładce, że dashboard się zrestartował, i
zostawiał proces, który dalej pracował i wydawał, a nikt już na niego nie patrzył. To dotyczyło
również istniejącej ścieżki pojedynczego filmu, nie tylko nowego kodu. Poza tym: ReDoS w
parsowaniu adresu (200 tys. znaków odbijane teraz w 0 ms) i błąd deduplikacji, przez który ten
sam film wypisany na obu zakładkach pod dwiema pisowniami adresu zostałby obejrzany — i
policzony — dwa razy.

---

## 4. Cztery zastosowania, w kolejności

### 4.1 Poranny digest / wejście w niszę — **v1**
Technicznie jedno i to samo: obejrzyj zestaw filmów, zwróć ustrukturyzowaną wiedzę,
zapisz do Obsidiana. Różni je tylko wyzwalacz.

- **codzienny:** śledzone kanały, konferencje, oficjalne keynote'y → budzisz się z wiedzą
  zamiast oglądać. Tu cron jest uzasadniony, bo publikacje dzieją się bez ciebie.
- **jednorazowy:** wchodzisz w nową niszę, skanujesz kanał albo hashtag, rozumiesz jak
  ktoś prowadzi kanał. Dolar, raz.

**Jedyne zastosowanie z dowodem popytu** — to na nie zareagowali ludzie pod postem na Skool.
Reszta to nasze hipotezy. Cele nie muszą być biznesowe: siłownia, pianino, cokolwiek,
gdzie ktoś *pokazuje*, jak się coś robi.

### 4.2 Wpięcie w montaż (VideoDirector) — **v2, najtwardsze uzasadnienie finansowe**

Stan obecny w `agent-os/source`:
- `api/video/auto/script` — Claude pisze scenariusz, sceny `{caption, narration_line, broll_prompt}`
- liczba scen = **`durationSec / 22`**, napisy rozłożone po **liczbie słów**
- `api/video/auto/assemble` — HeyGen jako `pipSrc` z `data-duration="${narrDur}"`,
  czyli awatar generowany na **całą długość filmu** i wyświetlany jako kółko 360 px w rogu,
  od początku do końca

Czyli rytm filmu wynika z arytmetyki na tekście, a nie z tego, co utrzymuje uwagę.
A za awatara płacisz na pełnej długości, żeby pokazać go w rogu.

OmniWatch dostarcza brakujące wejście: **zmierzony rytm zwycięzców w niszy** — ile trwa ujęcie,
kiedy pierwsze cięcie, kiedy twarz znika na rzecz nagrania ekranu, gdzie ląduje CTA.
To zastępuje `durationSec / 22` czymś sprawdzonym i zamienia awatara z „zawsze włączony"
na „włączony wtedy, kiedy ma znaczenie".

**Skutek finansowy:** generujesz HeyGena tylko na odcinki, gdzie twarz jest widoczna.
Sekundy 0–6 i 45–52 zamiast dziewięciu minut. Oszczędność na realnym, płatnym API,
policzalna przed produkcją. W tej społeczności to ma znaczenie, bo ludzie nie nagrywają
siebie, tylko generują awatara.

**To jest też odpowiedź na „moja wersja filmu Juliana".** Nie jest to przepisany scenariusz.
Jest to plan zdjęciowy, który mówi, **czego nie musisz generować**.

### 4.3 Wiedza proceduralna → agent computer-use — **najciekawsze, najbardziej ryzykowne**
Agent ogląda czyjeś nagranie ekranu i wie, jakie kroki wykonać. Potem agent z computer-use
odtwarza te kroki i sam nagrywa walkthrough. Film instruktażowy przestaje być gadającą głową
z B-rollem, a staje się rzeczywistym wykonaniem czynności. Nikt tego nie robi. Nie mamy pojęcia,
czy zadziała.

### 4.4 Rozbiór reklam — **ostatni, bo zajęty**
Sens ma, ale patrz §6. Jeśli wejdziemy, to jako pipeline (§5), nie jako osobny produkt.

---

## 5. Zasada wyjścia: schemat, nie proza

**Najważniejsza lekcja z researchu i bezpośrednia korekta tego, co zbudowałem.**

Ken Ashe, który zrobił to samo na reklamach: *„czterdzieści różnych etykiet na osiemdziesiąt
reklam i dane są bezużyteczne. Zablokuj do ośmiu, dziesięciu kategorii, a wzorce wychodzą
natychmiast."* I mocniej: **wartość nie leży w tym, że AI robi analizę, tylko w schemacie,
do którego ją zmusisz.**

Obecny teardown zwraca wolny markdown. To jest dokładnie ten błąd, i to tłumaczy uwagę
„markdown renderuje się jak gówno" — problem nie był w renderowaniu. **Proza nie jest
strukturą danych**, więc nie da się jej porównać między filmami ani policzyć z niej wzorca.

Zasady:
- **Omni wypełnia wiersze, nie wyciąga wniosków.** Zwraca pola z wymuszonymi enumami.
- **Każdy enum ma wyjście awaryjne** („żaden znany schemat"). Bez tego model wszystko
  nazywa Problem-Agitate-Solve, bo tak go nauczono.
- **Pole z poziomem pewności** dla tekstu z ekranu. Model pewnie zmyśla napisy, których
  nie umie odczytać; pole pewności pomaga w ~60% przypadków i nie naprawia problemu.
- **Wnioski robi drugi model.** Dostaje 200 wierszy i mówi, co się klastruje.
  To jest ta orkiestracja, o której mowa: Omni patrzy, mądrzejszy model myśli.

### Wyjście, które jako jedyne nie jest kradzieżą

Pytanie, które w obu znalezionych źródłach niezależnie okazało się najcenniejsze:

> **„Jakiego kąta w tym rynku wyraźnie brakuje?"**

Klasteryzacja mówi, co robią wszyscy. Brak mówi, co zrobić ty. Brief formułuje się przez
wzorzec, nie przez film: nie „zrób coś jak ta reklama", tylko „trzy koncepty we wzorcu
callout ze statystyką, kadr UGC twarzą do kamery".

---

## 6. Krajobraz — uczciwie

- **AdLibrary.com** sprzedaje `/api/enrichment`: teardown na Gemini, 1 kredyt za reklamę
  do 180 s, zwraca transkrypt z timestampami, odczyt strategiczny, rozbiór perswazyjny
  i **brief odtworzeniowy 1:1**. Plus „winners scan" po długości emisji. To jest nasze v1
  z §4.4, gotowe i na rynku.
- **Ken Ashe** zbudował wersję domową w weekend: Ad Library + zrzuty ekranu + GPT-4 Vision + arkusz.
- AdLibrary sam ostrzega, że **brief odtworzeniowy dziedziczy wady źródła**. Czyli „to znaczy
  ukradnij mu film" to nie idiosynkrazja, tylko znane ograniczenie branży.

Nasza realna przewaga techniczna: **ciągłe oglądanie z dźwiękiem zamiast próbkowania klatek.**
Ktoś zmierzył oba podejścia i pisze, że ponieważ model widzi obraz, dźwięk i upływ czasu
w jednym kontekście, osie w rodzaju „czy jest muzyka" i „w jakim języku mówią" wracają od razu,
czego wersja z klatkami nie odzyskuje.

**Korekta z 2026-09-20 — wcześniejsza wersja tego akapitu była nieprawdziwa.** Pisaliśmy,
że przewagą jest samo oglądanie obrazu, bo konkurencja czyta transkrypt. **HypeKit też
ogląda.** Ich dokumentacja każe agentowi wyciągnąć klatki (`media frames`), skleić je
w siatki razem z transkryptem (`media tile`) i wykryć granice ujęć (`media boundaries`),
a potem przeczytać to modelem multimodalnym. Założenie „oni mają tylko Whispera" było
nasze, nie ich.

Różnica została, ale jest węższa i uczciwiej brzmi tak: oni **tną film na klatki dla agenta
kodującego**, my **wysyłamy cały plik z dźwiękiem w jednym zapytaniu do modelu natywnie
omni**. U nas taniej i prościej — jedno wywołanie zamiast pipeline'u. U nich sterowalniej —
każdy krok da się podejrzeć i poprawić osobno. To jest wybór inżynierski, nie przewaga.

**Licencja HypeKita, do zapamiętania:** zmodyfikowany Apache 2.0. Zabrania multi-tenant
SaaS i sprzedaży pochodnych; użycie komercyjne u siebie i dla klientów jest dozwolone.
Niezależna implementacja podobnej **architektury** jest poza zasięgiem licencji na kod.
Czyli: ich kodu nie bierzemy, struktura jest wolna.

Kontrargument, który trzeba uszanować: przy reklamach **pierwsza sekunda rozstrzyga w ~90%**,
więc przy 15-sekundowym spocie pełne oglądanie może być wydatkiem na coś, co i tak
rozstrzyga się na starcie.

---

## 7. Co wypada z tego, co już stoi

| element | decyzja |
|---|---|
| sekcja „Your version" / napis **FILM THIS** | **usunąć.** Duplikuje Astrosa gorzej i czyta się jako „ukradnij film" |
| teardown jako wolny markdown | **zastąpić schematem** z enumami (§5) |
| Scout jako osobna zakładka w Hermesie | **usunąć.** Discovery na YouTubie robi Astros |
| lista obserwowanych kont jako główne wejście | zostaje, ale jako lista do **digestu** (§4.1), nie do rankingu wygranych |
| harmonogram, który ogląda wszystko | **zawęzić** do digestu: śledzone kanały i konferencje |
| Apify | **przełącznik, nie domyślnie.** Zarabia na siebie tylko przy pionowym short-formie |
| zakładka ręczna (wklej link, zapytaj) | **zostaje bez zmian.** Nigdy nie była problemem |
| chip przy temacie w Astrosie | **dodać.** `AstrosView.tsx:491-501` ma już rząd akcji: VIDEO AGENT, NOTEBOOK, SEO. Nasz jest czwarty |

Detal wart zapamiętania: **NotebookLM już dostaje film konkurenta jako źródło** — ale go czyta,
bo bierze transkrypt. Nasz chip to jedyny w tym rzędzie, który ten film ogląda. Te dwa przyciski
obok siebie tłumaczą produkt lepiej niż jakikolwiek opis.

---

## 8. Otwarte ryzyka

1. **Pobranie pliku z reklamy Meta niepotwierdzone.** Dane z WinningHuntera niosą nazwę pliku
   `.mp4`, nie adres. Linki fbcdn w odpowiedzi są z 2023 i podpisy wygasły. Do sprawdzenia,
   zanim §4.4 w ogóle ruszy.
2. **Mała próbka = przypadek.** Przy pięciu filmach „cztery z pięciu otwiera liczbą" może być
   szumem. Wyjście musi mówić „cztery z pięciu" i pokazywać które, nigdy „reguła niszy".
3. **Świeży temat nie ma danych.** Dwie godziny po premierze nikt nie ma wyświetleń.
   Obejście: pytaj o poprzedników („jak wyglądały wygrane filmy na premierze poprzedniego
   modelu"), bo format reakcji na premierę jest stabilny, zmienia się tylko przedmiot.
4. **Nazwa.** „Omni" w dyskursie oznacza dziś przede wszystkim *generowanie* wideo
   (Gemini Omni). „OmniWatch" siedzi w zajętej przestrzeni nazw.
5. **§4.3 to czysta hipoteza.** Nie wiemy, czy z obejrzenia da się wyciągnąć kroki
   wystarczająco precyzyjne dla agenta computer-use.

6. **Brak retry w silniku — defekt znaleziony w praktyce, nie w teorii.**
   Przy teście na filmie 21:26 Qwen zerwał połączenie bez odpowiedzi
   (`RemoteProtocolError: Server disconnected without sending a response`).
   Skrypt nie ma żadnego ponawiania ani backoffu, więc jedno zerwane połączenie
   zabija cały przebieg **po** pobraniu pliku i **po** wysłaniu go na oss://.
   Koszt i czas przepadają, użytkownik dostaje stack trace.

   To jest krytyczne dla §4.1, bo poranny digest ma chodzić bez człowieka przy klawiaturze.
   Digest, który wywala się na jednym filmie z pięciu i nic nie zapisuje, jest bezużyteczny.
   Wymagania: ponawianie z backoffem, **zapis częściowych wyników** (film po filmie,
   nie wszystko albo nic), i zapamiętanie, co już obejrzane, żeby ponowienie nie płaciło
   drugi raz. Krótki film (4 min) przeszedł bez problemu, więc problem rośnie z rozmiarem żądania.

7. **`PART_MAX` liczy minuty, a serwer liczy klatki — i te dwie rzeczy się rozjeżdżają.**
   Zmierzone: ~120 tokenów na klatkę. Film Qwena 247 s przy 2 kl/s = 494 klatki = 59 tys.
   tokenów, przeszedł. Film 1286 s przy 2 kl/s = **2572 klatki**, serwer zerwał połączenie.
   Podzielony na 3 części po ~429 s (858 klatek każda) przeszedł bez problemu.

   Haczyk: `fpsFor()` przełącza na **10 kl/s dla filmów ≤3 min**. Czyli **trzyminutowy short
   to 1800 klatek, więc większe żądanie niż dziesięciominutowy film przy 2 kl/s (1200 klatek).**
   `PART_MAX` wyrażony w minutach nie chroni przed tym w ogóle, a shorty to dokładnie ten
   materiał, który chcemy skanować na TikToku. **Próg musi być liczony w klatkach
   (`czas × fps`), nie w minutach.**

   Uwaga kosztowa: podział nie jest darmowy. Jedno żądanie szacowałem na ~6,8 centa,
   trzy części plus scalenie kosztowały 8,1 centa. Narzut kilkunastu do kilkudziesięciu
   procent, ale w wartościach bezwzględnych to grosze.

8. **Limit 480p nie działa na wideo pionowym — potwierdzony błąd, nie hipoteza.**
   Selektor formatu to `bv*[height<=480]+ba / b[height<=480] / bv*+ba/b`.
   Przy pionie `height` jest **dłuższym** bokiem, więc film 1080×1920 ma wysokość 1920,
   oba człony z limitem przepadają i wchodzi **fallback bez żadnego ograniczenia**.

   Widać to w cache'u: `854×480` dla filmu poziomego (limit zadziałał) obok
   **`1080×1920`** dla pionowego (nie zadziałał). To 2,07 mln pikseli na klatkę
   wobec 410 tys., czyli **pięciokrotny koszt klatki** — i dotyczy dokładnie
   tego materiału, który chcemy skanować: TikToków, Reelsów i Shortów.
   Złożone z `FPS_SHORT = 10` daje to trzyminutowy short = 1800 klatek po pięciokrotnej
   cenie. Wszystkie kalkulacje z §3 dla short-formu są zaniżone.

   Poprawka: zamiast twardego filtra na `height` użyć `-S "res:480"` — klucz `res`
   w yt-dlp bierze **mniejszy** z wymiarów, więc działa identycznie dla obu orientacji
   i nigdy nie spada do pełnej rozdzielczości.

   To prawdopodobnie tłumaczy też awarię z §8.6 lepiej niż liczba klatek: rozmiar żądania
   to klatki **razy koszt klatki**, a drugiego czynnika nigdzie nie kontrolowaliśmy.

## 8a. Notatka: Qwen-MM-Plugins (nie jest ryzykiem)

`QwenLM/Qwen-MM-Plugins` — *„Make any agent harness multimodal-native"*, 2934 gwiazdki,
aktywnie rozwijane, wspiera Claude Code, Openclaw i Codex. Znalezione przez nasze własne
narzędzie w niemym filmie (§2b).

W pierwszej wersji tego dokumentu wpisałem to jako największe ryzyko. **To był błąd oceny.**
Omni od początku jest modelem Qwena, więc to, że Qwen pakuje własny model we wtyczkę,
nie zmienia naszej pozycji. Zależność jest ta sama co wcześniej, tylko w innym opakowaniu.
Silnik nigdy nie był przewagą i nie miał być.

Przewagą jest to, czego wtyczka nie robi: pobieranie z wielu platform przez yt-dlp,
dzielenie długich filmów, cache, **zapis do Vaulta w konwencji reszty Agent OS**,
wpięcie w Astrosa, wyciąganie rytmu montażu, rachunek za HeyGena, i interfejs dla ludzi,
którzy nie otwierają terminala. Wtyczka celuje w developera z harnessem. Nasz użytkownik
klika przycisk.

Co z tego realnie zostaje:
- warto przeczytać `video-memory` (pamięć długiego wideo, ekstrakcja zdarzeń, wyszukiwanie
  po czasie), bo możemy tam znaleźć gotowe rozwiązanie problemu, który już obeszliśmy
  własnym dzieleniem na części. To pytanie „czy jest biblioteka", nie pytanie o strategię.
- jedyne miejsce z realnym nakładaniem się to pomysł „Hermes ogląda film na czacie".
  Tam ich wtyczka może być lepszą drogą niż nasz własny MCP. To jest pomysł poboczny,
  nie produkt z §4.

**Potwierdzenie tezy zostaje:** dostawca modelu niezależnie uznał, że „agent nie widzi"
to problem wart produktu.

---

## 8b. Dystrybucja — jak to trafia do społeczności

Źródło: kurs 36 (`ai-profit-lab-7462`) w `pythonProject22/courses.sqlite`, rozdział
„How to Make Money Fast with Affiliate Marketing", lekcje 6238, 6248, 6249.
**Nie scrapować Skoola — to już jest zaindeksowane lokalnie, 826 lekcji.**

Mechanika reshare'u (lekcja 6248, METHOD 3): **reshare nie jest automatyczny.**
Post na X i LinkedIn → **oznaczyć go + wysłać mu DM z linkiem** → wtedy robi reshare,
komentarz i like. Wyzwalaczem jest tag plus DM, nie sama publikacja. Prowizja **40%,
cykliczna**. Działa też miesięczna rywalizacja: najwięcej postów do 20. dnia = 500 $.

Ograniczenia, które wiążą nasz film (lekcja 6238):
- **Nie YouTube Shorts** — brak klikalnych linków. Cel: X i LinkedIn.
- **Twarz autora** przy własnym materiale („just use your face").
- Link afiliacyjny **na górze i na dole** posta, przy recenzji obowiązkowy disclaimer.
- Próg jakości jego własnymi słowami: *„would you find it interesting + entertaining?
  If not, rewrite it"* plus storytelling i unikalność.

**Nasza przewaga nad jego playbookiem.** Standardowa ścieżka to przeklejony testimonial
albo klipowanie filmów Juliana (tak wygrywa lider rywalizacji). Wymóg „feel unique"
jest w tym playbooku życzeniem, którego sam playbook nie spełnia. My mamy działające
narzędzie wpięte w Agent OS, o którym on sam nagrywa. Najmocniejsza wersja posta:
**film o narzędziu, zmontowany przez to narzędzie, z twarzą autora i jawnie powiedziane,
że montaż zrobił agent.**

Decyzja (2026-09-20): link afiliacyjny **tak**, z disclaimerem. Nie jest to wyłączność —
gdy urośnie własny zasięg, w to miejsce wchodzą własne produkty. Rzecz do domknięcia
na końcu, nie blokuje budowy.

---

## 8c. Zrobione 2026-09-20 (z dowodami)

**Punkt 1 — chip w Astrosie.** `register-nav.py` dostał `patch_astros()`: idempotentna
wstawka chipa `OMNI WATCHES IT` do rzędu akcji plus reguła CSS. Nie edytowane ręcznie,
bo `agent-os/source` nie ma gita. `OmniWatchView` czyta `?url=`, startuje sam i wycina
parametr z adresu, żeby przeładowanie nie płaciło drugi raz. Zweryfikowane w DOM
i przebiegiem end-to-end.

**Punkt 2 — trzy defekty silnika**, wszystkie potwierdzone pomiarem, nie rozumowaniem:

- *Format pobierania.* `-S "res:480"` zamiast filtra na `height`. Stary selektor miał dwie
  twarze naraz: TikTok **1080×1920** (pięciokrotny koszt klatki, bo żaden format nie miał
  `height<=480` i wchodziła gałąź bez limitu) oraz YouTube Short **240 px szerokości**
  (bo `height` 426 ≤ 480, więc brał najmniejszy — za mało, by odczytać napisy na ekranie).
  Klucz `res` to mniejszy z wymiarów, więc jedna reguła obsługuje obie orientacje.
- *Próg podziału w klatkach* (`MAX_FRAMES`, domyślnie 2400), nie w minutach.
- *Ponawianie z rozróżnieniem błędów.* Zerwane połączenie, 429 i 5xx → nowa próba
  z narastającym odstępem. 4xx → od razu wyżej. Pętla czytająca strumień też opakowana,
  bo zerwanie w połowie zostawiało tekst ucięty wyglądający na kompletny.

**Dowód:** film 21-minutowy, który wcześniej wywalał się z `RemoteProtocolError`, przeszedł
sam: **2 części, 358 348 tokenów, 0,0558 $, 176 s, bez błędu.** Wcześniejszy ręczny przebieg
z wymuszonym podziałem: 3 części, 0,081 $. Czyli o **⅓ taniej** przy mniejszym narzucie.

**Sekcja „Your version" usunięta** — i miała wadę, której nie znaliśmy. Bez podanego tematu
model wymyślał losową niszę (przy filmie o spalaniu tłuszczu wyszło „Productivity/Focus
Techniques") i pisał **pod tymi samymi nagłówkami** pełny drugi rozbiór. Stąd „markdown
renderuje się jak gówno": to nie było renderowanie, tylko dwa sklejone dokumenty.
Po usunięciu: **6 nagłówków, 6 unikalnych**.

Pole tematu zostało, ale zmieniło rolę: nie pisze Twojego scenariusza, tylko mówi,
**które decyzje przeniosą się na Twój temat, a które były nośne tylko dla ich**.
To jest §5 („ograniczenia, nie treść") przeniesione z deklaracji do promptu.

**Punkt 3 — skan kanału na żądanie (§3b).** Istniejąca zakładka `/omniwatch` dostała
trzeci tryb, nie nową zakładkę. Listowanie konta jest darmowe (yt-dlp), oglądanie płatne,
i cena stoi na ekranie przed pobraniem czegokolwiek.

Sprawdzone: **YouTube** (@JulianGoldieSEO — 424 000 subskrybentów, 120 filmów z dwóch
zakładek), **TikTok** (@zachking — płaska lista z metrykami), **Instagram** przez Apify, bo
yt-dlp tam nie sięga. Pełny przebieg płatny: short Juliana obejrzany za **$0,0044**, teardown
zapisany do Vaulta. Ścieżka porażki też sprawdzona nie teorią: TikTok zablokował IP przy
jednym poście, a partia nie wywaliła się — błąd wylądował przy tym jednym filmie, koszt $0,
Vault słusznie nietknięty.

**Dwie rzeczy dołożone po uwagach w trakcie:** sufit trzydziestu filmów zdjęty (kanał Juliana
ma ich 6873, nie 30 — nazywanie trzydziestki „całym kanałem" było nieprawdą), a zakładka
dostała historię skanów, bo wcześniej po zapłaceniu za skan nie było gdzie zobaczyć, co się
zrobiło; Vault jest archiwum dla agenta, nie widokiem dla człowieka.

**Przegląd kodu znalazł cztery realne defekty** (§3b). Najpoważniejszy: wycena mogła wyjść
**4,7 raza poniżej** rachunku na granicy trzech minut — czyli dokładnie to, czego ta funkcja
obiecuje nie robić. Drugi dotyczył także istniejącej ścieżki pojedynczego filmu: zadanie
dłuższe niż godzina usuwało samo siebie z pamięci i zostawiało proces, który dalej wydawał.

---

## 8d. Skan kanału — co się zmieniło po pierwszym użyciu

Trzy rzeczy wyszły dopiero wtedy, kiedy ktoś tego użył, i każda była błędem projektu,
nie implementacji.

**Nie ma jednego powodu, dla którego się skanuje.** Zakładka zaczęła od dwóch pomysłów:
co film mówi i jak jest zrobiony. To okazało się za wąskie w momencie, w którym pojawił
się pierwszy prawdziwy powód, który był ani jednym, ani drugim — „jakie marki ubrań
występują na ekranie", „jakiego koloru są samochody". Kanał o zrzucaniu kilogramów
oglądamy dla treści. Kanał Juliana — dla treści **i** rzemiosła. Więc zamiast trybu
jest **biblioteka presetów** (`omniwatchPresets.ts`: `both`, `content`, `craft`, `brands`,
`wardrobe`, `claims`, `setting`) plus **puste pole**, bo lista nigdy nie pokryje tego,
czego ktoś naprawdę chce. Presety nie wymagały nowej maszynerii: pytanie o film silnik
już umie, więc preset to po prostu gotowe pytanie.

Jedna linia dokleja się do każdego presetu: *trzymaj te same etykiety dla każdego filmu*.
Kosztuje zero, a jest różnicą między trzydziestoma odpowiedziami, które da się zestawić
obok siebie, a trzydziestoma, których się nie da.

**„Cały kanał" przy limicie 30 to było kłamstwo.** Po zdjęciu sufitu opcja ALL na
prawdziwym koncie pokazała **6873 filmy, ~292 $**. Dlatego ALL istnieje, ale zawsze
z liczbą przed kliknięciem, nie z ostrzeżeniem ogólnym. Sufitem na jeden skan zostało 500.

**Archiwum w Obsidianie to nie jest widok dla człowieka.** Vault jest dla agenta — proza
w datowanym pliku, dobra do czytania później przez model. Człowiek, który zapłacił za
przeskanowanie kanału, musi zobaczyć **co już przeskanował**, bez grzebania w Obsidianie.
Stąd historia skanów zapisana obok (`~/.agentic-os/omniwatch/channels/`) i wylistowana
w zakładce.

### Progi wejścia dla źródeł — bo to decyduje, komu co pokazujemy

| źródło | co trzeba mieć | listowanie | uwaga |
|---|---|---|---|
| YouTube | nic | darmowe (yt-dlp) | zero setupu, domyślne |
| TikTok | nic | darmowe (yt-dlp) | zero setupu, domyślne |
| Instagram | token Apify | **płatne** | ekran musi to mówić przed kliknięciem |
| X (Twitter) | token Apify | **płatne** | `apidojo~tweet-scraper` |
| Reklamy Meta | token Apify | **płatne** | `igolaizola/facebook-ad-library-scraper`, 0,30 $ / 1000, bez logowania |

Wniosek, który z tej tabeli wynika i którego łatwo nie zauważyć: **reklamy Meta nie są
funkcją dla społeczności Juliana.** Ta społeczność jest nietechniczna — „załóż konto
i wklej token" znaczy dla niej to samo co „tej funkcji nie ma". Reklamy Meta są dla
części e-commerce, która i tak ma Apify albo ma kogoś, kto ma. Zero-setup zostaje
YouTube i TikTok i to one muszą wystarczać na demo.

---

## 8e. Most do montażu — obejrzany film staje się filmem do zrobienia

Do dziś OmniWatch kończył się na stronie. Czytałeś rozbiórkę, zamykałeś kartę i nazajutrz
odtwarzałeś ją z pamięci — czyli odtwarzałeś wrażenie, nie film. Teraz rozbiórka kończy
się przyciskiem.

**Ścieżka, która działa end-to-end** (sprawdzona na żywo 2026-09-20): Astros znajduje film
→ chip `OMNI WATCHES IT` → OmniWatch ogląda → **„Make one like this"** → wpisujesz **swój**
temat → `/video?brief=<id>` otwiera Director wypełniony: temat, długość, prezenter albo
lektor, i pasek mówiący skąd wzięty jest rytm → skrypt na tyle scen, ile było ujęć →
HeyGen albo ElevenLabs → b-roll → montaż z jawnymi sekundami → HyperFrames.

**Granica jest wymuszona kodem, nie deklaracją.** Brief nie zapisze się bez tematu —
endpoint zwraca błąd, nie domyślną wartość. Pola `narration_line` i `caption` są puste
z definicji typu. Przenosi się rytm: ile ujęć i jak długo każde trwa. Sekcja „Your version"
została skasowana właśnie za to, że czytała się jak „ukradnij ten film", i gotowy plan
montażu z cudzymi zdaniami byłby tym samym pod inną nazwą.

### Zegar wybiera się per film, i to jest wynik pomiaru

Dwa źródła rytmu nie zgadzają się ze sobą, i oba mają rację na swoim terenie:

| film | ffmpeg (T=0,15) | co mówi model | czyj zegar |
|---|---|---|---|
| TikTok, 128 s | 34 cięcia | „3–5 cięć/10 s" — zgadza się | **ffmpeg** |
| Short 47 s, stałe kadrowanie | 2 cięcia | „6 cięć/10 s", 15 momentów | **model** |

Model pytany trzykrotnie o ten sam 47-sekundowy plik odpowiadał 4, potem 12, potem 2–3
cięcia na 10 s — jego deklarowane tempo nie jest pomiarem. Ale ffmpeg na tym samym pliku
widzi 2 cięcia, bo **kadr się nie zmienia**: tempo niosą napisy i grafiki podmieniane
wewnątrz jednego ujęcia, a detektor różnicy pikseli słusznie tego nie widzi jako cięcia.
To jest dokładnie format, który robi ta społeczność. Więc `rhythmFrom` wybiera i **zapisuje
w briefie, dlaczego** — nie ma cichego wyboru.

### Co było zepsute po drugiej stronie

Dwa sufity, oba niewidoczne z zewnątrz, oba podnoszone łatką z wartownikiem:

- `auto/assemble` brał `scenes.slice(0, 12)` — skopiowany rytm z pięćdziesięcioma
  scenami tracił większość siebie, a żądanie zgłaszało sukces. Teraz 60.
- `auto/script` przyjmował `sceneCount` do 24, po czym tął wynik do 12. Teraz 60,
  sprawdzone: prośba o 15 scen zwraca 15.

Trzecia rzecz nie była sufitem, tylko pominięciem: `seconds` sterowały wyłącznie czasem
napisów, a b-roll dalej leciał w pętli po własnych długościach klipów. Czyli napisy szły
w przepisanym rytmie, a obraz ciął się po swojemu — a to gdzie tnie obraz jest jedyną
rzeczą, dla której ta funkcja istnieje.

### Grafiki: ffmpeg odpadł, zanim zdążył wejść

Karty w rodzaju „od najlepszego do najgorszego" — to, na czym stoją przykłady HypeKita —
miały powstawać ffmpegiem. Nie powstaną: **ffmpeg na tej maszynie nie ma `drawtext`**
(zbudowany bez libfreetype, `ffmpeg -filters | grep drawtext` zwraca zero), a lekarstwem
jest `brew install ffmpeg-full`. Dla nietechnicznej społeczności to znaczy „tej funkcji
nie ma" — patrz tabela progów w §8d. Więc grafiki idą jako **HTML w kompozycji**, którą
HyperFrames i tak renderuje do MP4: zero nowych zależności, zero setupu, i animacja
gratis, bo GSAP już tam jest. Generator ffmpegowy zostaje jako ścieżka dla maszyn, które
mają pełny build, i mówi wprost, czego im brakuje.

### Twardnienie wejść grafik (2026-09-20, po security review)

`GraphicSpec` jest danymi od modelu, więc walidacja stoi teraz w `omniwatchGraphic.ts`
(`validateGraphicSpec`), a nie w route: `renderGraphic` jest eksportowane, a walidacja
w route biegnie **poza** `try`, więc każdy wyjątek stawał się 500. `items: [null]`
robiło dokładnie to (`typeof null === "object"` przechodziło starą kontrolę).
Opcjonalne `value`/`caption`/`attribution` są sprawdzane na typ i długość, listy i czas
mają sufity, a `bytes=-N` w `GET ?file=` zwraca ostatnie N bajtów zamiast 0..N.

Ograniczenie, którego nie da się obejść kodem: **ten ffmpeg nie ma `drawtext`**
(build bez libfreetype), więc ffmpegowa ścieżka grafik jest pokryta testami walidacji,
escapowania filtrów i range'ów, ale **nie renderem MP4**. Produkcyjnie karty idą jako
HTML w kompozycji montażu — bez `ffmpeg-full`.

---

## 9. Co dalej
Skan kanału (§3b) — zrobiony 2026-09-20. To wejście do wszystkich aplikacji.

v1 = §4.1: obejrzyj zestaw filmów → ustrukturyzowana wiedza → Obsidian.
Dwa wyzwalacze (codzienny dla śledzonych, jednorazowy dla kanału/hashtagu).
Plus chip w Astrosie, bo kosztuje jeden przycisk.

Potem §4.2, bo ma liczbę na końcu (rachunek za HeyGena).

§4.4 dopiero po rozstrzygnięciu ryzyka 1 i po decyzji, czy wchodzimy na zajęty rynek.
§4.3 jako eksperyment, nie jako obietnica.
