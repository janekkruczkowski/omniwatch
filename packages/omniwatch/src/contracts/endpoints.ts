/**
 * Provider endpoint composition (D9).
 *
 * The released Python beta used two DIFFERENT paths on the same DashScope host:
 *   - model:  `{DASHSCOPE_API}/compatible-mode/v1` (OpenAI-compatible mode),
 *   - upload: `{DASHSCOPE_API}/api/v1/uploads?action=getPolicy&model=...`.
 * A single "base URL" knob cannot serve both, so this module derives each endpoint
 * from the ONE configured host and keeps the documented default working when the
 * user sets only a key.
 *
 * Rules (verified against the beta and the compatible-mode convention):
 *   - an explicitly full endpoint (`.../chat/completions`) is used as-is;
 *   - `.../compatible-mode/v1` gets `/chat/completions`;
 *   - a bare DashScope host gets `compatible-mode/v1/chat/completions` - never a
 *     bare `/v1`, which is the upload API's shape;
 *   - uploads always target `{host}/api/v1/uploads`, with any known suffix stripped.
 */

/** The documented DashScope Model Studio default endpoint. */
export const DEFAULT_DASHSCOPE_HOST = "https://dashscope-intl.aliyuncs.com";

function stripTrailing(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Host part of whatever the user configured, for the upload API. */
export function dashscopeHost(base: string | null | undefined): string {
  const trimmed = stripTrailing(base ?? "");
  if (trimmed === "") return DEFAULT_DASHSCOPE_HOST;
  return trimmed
    .replace(/\/compatible-mode\/v1\/chat\/completions$/, "")
    .replace(/\/compatible-mode\/v1$/, "")
    .replace(/\/v1\/chat\/completions$/, "")
    .replace(/\/api\/v1\/uploads.*$/, "")
    .replace(/\/+$/, "");
}

/** OpenAI-compatible chat endpoint for the configured host. */
export function chatCompletionsUrl(base: string | null | undefined): string {
  const trimmed = stripTrailing(base ?? "");
  if (trimmed === "") return `${DEFAULT_DASHSCOPE_HOST}/compatible-mode/v1/chat/completions`;
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/compatible-mode\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  // An explicit generic `/v1` stays generic (other OpenAI-compatible providers),
  // but a bare DashScope host must use its compatible-mode prefix.
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  if (/dashscope/i.test(trimmed)) return `${trimmed}/compatible-mode/v1/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** Upload-policy endpoint (the only upload API call the beta makes). */
export function uploadPolicyUrl(base: string | null | undefined, model: string): string {
  const host = dashscopeHost(base);
  return `${host}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
}
