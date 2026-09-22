# OmniWatch — bazowy checkout autonomicznego wykonania

Izolowany punkt bazowy dla zadan T0–T9 z `docs/omniwatch/`. Utworzony 2026-09-22
na galezi `codex/omniwatch-foundation`; pochodzenie plikow wejsciowych opisuje
`ORIGIN-INVENTORY.md`.

Ten checkout nie zawiera sekretow, prywatnego Vaulta, `.cache/`, `summaries/` ani
zaleznosci drugiego projektu. Drzewo `video-watch` pozostaje nietkniete.

## Uruchomienie

```bash
node --test packages/omniwatch/test/     # testy kontraktow i modulow
npm run build                            # tsc + paczka (wymaga typescript)
npm run poc                              # demonstracja POC na sztucznym providerze
```
