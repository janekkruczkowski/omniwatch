# INSTALL-WITH-AI.md — instructions for the agent

You are setting up **OmniWatch** on this person's computer. They may not be technical: do the work
yourself, explain in plain language, and only ask when you need a decision or a secret from them.

Work inside the folder that contains this file.

## Step 1 — check what is already there

```bash
uv --version; yt-dlp --version; ffmpeg -version | head -1
```

Install whatever is missing:

- **uv** (runs the app, no Python setup needed): `curl -LsSf https://astral.sh/uv/install.sh | sh`
  (Windows PowerShell: `powershell -c "irm https://astral.sh/uv/install.ps1 | iex"`)
- **yt-dlp** (downloads the videos): `uv tool install yt-dlp`
- **ffmpeg** (cuts frames and long videos): macOS `brew install ffmpeg` · Windows `scoop install ffmpeg`
  · Debian/Ubuntu `sudo apt install ffmpeg`. If Homebrew/Scoop is missing, install that first.

Afterwards, re-run the version checks and confirm all three answer.

## Step 2 — the API key

OmniWatch calls **Qwen3.8-Omni-Flash** at Alibaba Model Studio (pay-as-you-go).

Tell the user, in plain words:

> "You need one key from Alibaba Model Studio (modelstudio.console.alibabacloud.com → API keys).
> New accounts get free credits; after that, a question about a 10-minute video costs about 3 cents.
> Paste the key here and I'll put it in the right file — it never leaves your computer."

Then:

```bash
cp .env.example .env
```

and write the key into `.env` as `DASHSCOPE_API_KEY=sk-…`.

**Never** commit `.env`, never paste the key into chat logs, screenshots or a git repo, and never put it
anywhere except that file. If the user pasted the key into the chat, remind them they can rotate it later.

If they use a region other than Singapore, set `DASHSCOPE_API=https://dashscope.aliyuncs.com` (Beijing)
or the endpoint for their region in `.env`.

## Step 3 — start it

```bash
uv run app.py
```

First run downloads the Python dependencies (a few seconds). Then open <http://localhost:8765> and tell
the user it is ready. Offer to run a first test with them: paste a short YouTube or TikTok link, ask a
question, and show them that the answer cites timestamps with real frames.

If port 8765 is taken, start it with `uv run app.py` after setting a different port in `app.py`
(`uvicorn.run(..., port=…)`) and tell the user the new address.

## Step 4 — tell them how to use it

- **Ask** mode: paste a link, type a question, get an answer with evidence. Empty question = full summary.
- **Teardown** mode: paste a link to a video that works in their niche; they get the hook, beat by beat,
  editing, on-screen text, sound, CTA, plus a ready script adapted to the topic they typed.
- Language picker (top right): English, Polish, German, Spanish, French.
- Follow-up questions about the same video are cheap and fast — the video is already uploaded.
- Downloaded videos are deleted from their disk automatically after 48 h.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Set DASHSCOPE_API_KEY` | `.env` is missing or the key line is wrong |
| `yt-dlp failed: HTTP Error 403` | yt-dlp is out of date: `uv tool upgrade yt-dlp` |
| Instagram/Facebook link fails | those often need a login; use cookies (`yt-dlp --cookies-from-browser chrome`) or another link |
| `Model not exist` | the key is from a plan without Omni (e.g. Token Plan) — use a pay-as-you-go Model Studio key |
| Answer is in the wrong language | change the picker in the top right, or set `OMNI_LANG` in `.env` |

When you are done, summarise for the user in two sentences: what is installed, where it runs, and what
it costs per question.
