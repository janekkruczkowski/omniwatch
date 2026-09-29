# OmniWatch — instructions for coding agents

Knowledge from videos: a film (YouTube, TikTok, upload) is split into parts, each part is analysed by a video model (Qwen via DashScope; parts Qwen's content filter refuses go to `google/gemini-3.8-flash` via OpenRouter), and the user gets answers/summaries. Start with `README.md` and `docs/omniwatch/TECHNICAL.md`.

Layout: `packages/omniwatch` (engine, providers, storage), `agent-os-module` (Agent OS integration and panel UI), `apps/standalone` (standalone app), `scripts/release` (build + install).

The montage tool (Studio) is a separate repository: `janekkruczkowski/studio`. Don't mix the two.

## Rules

- **npm, not pnpm**, in this repo. Node 24 (`~/.nvm/versions/node/v24.15.0`; the default `node` on PATH may be older).
- **Never `git push`** unless the user asks for that push explicitly. Local commits and merges are fine.
- Commits end with `Co-Authored-By: <model> <noreply@anthropic.com>` (or the equivalent for your tool).
- **Never print API keys or secrets.** Keys: `DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY` (in `.env` files or `~/.agentic-os/*.env`).
- **Gemini: only `google/gemini-3.8-flash`.** Never an older Gemini.
- Tests use mocked HTTP; no paid calls in tests. Before calling it done: `npm run typecheck` and `npm test`.

## Build and deploy

- Package: `npm run build` → `dist/release/omniwatch-core-<ver>.tgz` + manifest.
- Install: `node scripts/release/install.mjs --target agent-os|standalone --root <dir> [--check|--rollback]`.
- Local standalone: port 18767, `~/Documents/Codex/2026-09-20/przejmij-prace-od-claude-nad-omni/omniwatch-preview-rc` (`start-preview.sh` / `stop-preview.sh`).
- Server `openclaw-ovh` (ssh): Agent OS in `~/agent-os/source`, systemd user service `agent-os` (127.0.0.1:3737), env drop-ins in `~/.config/systemd/user/agent-os.service.d/`. Build in a copy (`~/agent-os/source-build`, hard-linked `node_modules` — Turbopack rejects a symlink), then swap `.next`. The disk is nearly full and RAM is 8 GB. Log every change in `~/omniwatch-deploy/main-notes.log`.
- On the server don't touch OpenClaw, codex, ntfy-mcp or other services; no firewall, SSH or user changes. Every Paperclip restart invalidates invites.

## Talking to the user

Polish, short, plain language. Give status/ETA when asked.
