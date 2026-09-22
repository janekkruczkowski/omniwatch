/**
 * GET /api/omniwatch/i18n — the same translations the prompts use, handed to the tab
 * so its headings always match what the model was told to write (T6).
 */

export function createI18nHandler(i18n: unknown) {
  return {
    async GET(): Promise<Response> {
      return new Response(JSON.stringify(i18n), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}
