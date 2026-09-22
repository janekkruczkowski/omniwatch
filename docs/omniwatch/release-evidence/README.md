# OmniWatch — dowody odbioru (offline)

Data: 2026-09-22. Rewizja: gałąź `codex/omniwatch-foundation` w izolowanym checkoutcie
`/Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/omniwatch-autonomous`.
Dokument rozdziela **wykonane i działające**, **niewykonane** i **blokady zewnętrzne**.
Nie deklaruje pełnego odbioru na podstawie stubów.

## 1. Wykonane i zielone

| Sprawdzenie | Komenda | Wynik |
|---|---|---|
| Typy | `npx tsc -p tsconfig.json --noEmit` | exit 0 |
| Cały zestaw offline | `node scripts/test-all.mjs` | **226 testów, 225 PASS, 0 FAIL, 1 SKIPPED** |
| Bramka POC T0–T3 | `node scripts/poc/demo.mjs` | **23/23**, 5 wywołań stuba, 0 kluczy API |
| Beta → wspólny rdzeń | `node --test test/install/python-beta.test.mjs` | **14/14** (z uprawnieniem `listen`); bez niego 13 PASS + 1 SKIPPED |
| Instalator/wydanie | `node --test test/install/release.test.mjs` | **15/15** |
| Ewaluacje offline | `node test/eval/omniwatch/run-evals.mjs` | 3 PASS (E05), 4 NOT_EXECUTED |
| Artefakt | `node scripts/release/build-core.mjs` | tarball 161 plików, sha256 `000bc8327b59c52bb5fabbc787b3c8bef14e093b69d0dd5d2d241ae66a413efd` |
| Worker na prawdziwym hoście | `node --test test/e2e/host-worker.test.mjs` | **3/3** przeciw `/Users/janek/Documents/agent-os/source` |
| Standalone live | start na `127.0.0.1:8765` z fixture'ami | `/i18n.json` 200, `Range: bytes=0-99` → **206/100 B**, klatka JPEG 200 |

Zakres pokryty tymi testami: walidacja wejścia, silnik summary/focus/teardown/dopytanie,
deduplikacja powtórzeń, trwały SQLite z właścicielem i migracjami, bufor i dostarczanie
bez powtarzania modelu, `outcome_unknown` bez automatycznej płatnej próby, adapter Vault
(notatki indywidualne, konflikt zamiast nadpisania, wyszukiwanie PL), skany z kursorami
i raportami, migracja bety bez wywołań modelu, instalator z preflight/rollback/konfliktami,
osobny proces roboczy na grafie hosta Agent OS.

## 2. Wykonane pomiary

- 10 000 metadanych: 200 stron po 50; czas strony p50 18 ms, **p95 28 ms**, max 53 ms
  (cel planu p95 < 250 ms); przyrost RSS **+10.2 MiB** (budżet < 100 MiB);
  cała enumeracja 3.8 s; pełny `runScan` z `maxNewItems: 0` — 7.3 s, 0 wywołań modelu.
- Koszt rzeczywistych wywołań API: **0 USD** — wszystkie testy używają stuba.

## 3. Niewykonane (jawne)

| Element | Powód | Jak domknąć |
|---|---|---|
| E01–E04 na żywym modelu | brak klucza i budżetu dostawcy | `OMNIWATCH_API_KEY=... node test/eval/omniwatch/run-evals.mjs --live` na dozwolonych próbkach |
| Build Next i odbiór w przeglądarce | w checkoutcie nie ma `next`/`react`/Playwright | root uruchamia gstack QA na kopii hosta wg `QA-HANDOFF-OMNIWATCH.md` |
| A10 na czystym hoście Agent OS | wymaga czystej instalacji u odbiorcy | QA na kopii `/Users/janek/Documents/agent-os` |
| Macierz macOS/Windows/Linux | dostępny tylko macOS | uruchomić `test/install/release.test.mjs` na Windows i Linux |
| Pilotaż i publikacja społecznościowa | decyzja człowieka, poza zakresem wykonawcy | bramka wydania u użytkownika |
| Realne źródła (yt-dlp/Apify/Vault) | brak autoryzacji i danych | QA z kluczem i odizolowanym Vaultem |

## 4. Znane ograniczenia architektoniczne

- Panel Agent OS domyślnie wykonuje operację w procesie (adaptery hosta używają aliasu
  `@/`); osobny proces jest dostępny i **zweryfikowany** przez
  `omniwatch-host-worker.mjs` + `omniwatch-host-loader.mjs`. Przełączenie panelu na
  worker to konfiguracja `OMNIWATCH_WORKER=cli` po stronie instalacji.
- Adapter pamięci powstał przeciw kontraktowi `vault.ts` (root + notatki Markdown);
  odbiór na konkretnym Vaultcie użytkownika pozostaje bramką A10.
- `node:sqlite` w Node 22 ma status eksperymentalny — zgodnie z przyjętym D6; wersja
  Node jest sprawdzana w preflight instalatora.

## 5. Reprodukcja

```bash
cd /Users/janek/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/omniwatch-autonomous
npx tsc -p tsconfig.json --noEmit
node scripts/test-all.mjs
node scripts/poc/demo.mjs
node scripts/release/build-core.mjs
node test/eval/omniwatch/run-evals.mjs
```

Wyniki ewaluacji w formacie maszynowym: `docs/omniwatch/release-evidence/eval-results.json`.
