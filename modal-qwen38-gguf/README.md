# Qwen3.8-27B-Uncensored GGUF Q8_0 na Modal

Wariant tekstowy, zgodny z API OpenAI, na jednej karcie NVIDIA RTX PRO 6000
(96 GB VRAM). To adaptacja przykładu Modal z Gemma 4, **nie** zamiana samej
nazwy modelu. Plik `Qwen3.8-27B-Uncensored-Q8_0.gguf` (ok. 29 GB) jest
pobierany z określonej rewizji do Modal Volume razem z wymaganym przez
plugin projektorem `mmproj-Qwen3.8-27B-Uncensored-F16.gguf`. Nie pobieramy
wszystkich kwantyzacji (repozytorium ma ponad 200 GB) ani wag bf16 do tokenizera.

Obraz ma CUDA 13.0 (zgodną z domyślnym kołem PyPI vLLM 0.30.0).
Zainstalowany jest vLLM 0.30.0 i skompilowany ze źródeł plugin GGUF
(przypięty commit). Dla stabilnego pierwszego testu MTP jest wyłączone,
multimodalność wyłączona, a kontekst ograniczony do 8192 tokenów. MTP w
pliku *fused* można przetestować później z
`--speculative-config '{"method":"mtp","num_speculative_tokens":1}'`;
nie dodawaj flag specyficznych dla Gemma 4.
Tryb API pozostaje tekstowy, lecz loader GGUF potrzebuje obecności projektora
do zainicjalizowania multimodalnej architektury Qwen3.5.

## Uruchomienie

1. Skonfiguruj konto Modal z metodą płatności, zainstaluj klienta
   `python -m pip install modal` i wykonaj `modal setup`.
2. W katalogu tego pliku uruchom `modal deploy vllm_inference.py`.
   **To uruchamia płatny GPU** przy pierwszym żądaniu, a czas rozruchu
   obejmuje pobranie wag i kompilację. Deployment sam w sobie nie dowodzi,
   że silnik załadował model.
3. Utwórz Modal Proxy Token w panelu Modal i trzymaj go poza repozytorium.
   Zachowaj URL serwera wypisany po deployu (kończy się na `.modal.direct`).
4. Ustaw lokalnie `MODAL_URL` na ten URL i `MODAL_PROXY_TOKEN` na pełny
   token w formacie `wk-<id>.ws-<secret>`, po czym sprawdź:

```bash
curl -i -H "Authorization: Bearer $MODAL_PROXY_TOKEN" "$MODAL_URL/health"
curl -sS -H "Authorization: Bearer $MODAL_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  "$MODAL_URL/v1/chat/completions" \
  -d '{"model":"qwen38-27b-uncensored-q8","messages":[{"role":"user","content":"Odpowiedz jednym zdaniem po polsku: co to jest vLLM?"}],"max_tokens":128}'
```

Przy `min_containers=0` pierwsze żądanie może dostać **503** i uruchomić
kontener; ponów je po chwili. Błędy wczytywania modelu sprawdzaj w logach
aplikacji Modal. Publiczny endpoint z artykułu (`unauthenticated=True`)
celowo zastąpiono wymaganiem Proxy Tokena.

## Zastrzeżenia

- vLLM obsługuje architekturę `Qwen3_5ForConditionalGeneration`, a plugin
  wymienia testy Qwen 3.5, lecz ta **konkretna kombinacja** Qwen3.8 + fused
  GGUF Q8_0 + RTX PRO 6000 nie została tutaj uruchomiona. To punkt startowy
  do testu, nie obietnica kompatybilności.
- Sama wielkość pliku 29 GB nie gwarantuje pełnego kontekstu 262144 tokenów
  ani wysokiej równoległości; po starcie zmierz zajętość VRAM i wydajność.
- Koszt GPU zależy od czasu działania, a Volume od wykorzystanej przestrzeni;
  kontroluj wydatki w Modal. Na 25.09.2026 cena samego RTX PRO 6000 to
  **$0.000842/s (~$3.03/h)**, dodatkowo rozliczane są CPU i RAM.
  `scaledown_window=300` utrzymuje kontener jeszcze 5 minut bez żądań
  (około $0.25 za sam GPU, jeśli kontener zostaje przez pełne 5 minut).

Źródła: karta modelu na Hugging Face, dokumentacja GPU i Server Modal,
dokumentacja modeli vLLM 0.30.0 oraz README `vllm-gguf-plugin`.
