---
target: studio-redesign (Studio HITL app redesign mockups)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 1
target_identity: "file:/Users/janek/Documents/Aplikacje/video-watch/studio-redesign/index.html"
target_fingerprint: "sha256:33bf399deef802f59a8ad97751e3919a567d0d6f5472a6c708f939aa955632cb"
target_path: /Users/janek/Documents/Aplikacje/video-watch/studio-redesign/index.html
timestamp: 2026-09-24T10-00-50Z
slug: studio-redesign-index-html
---
# Critique: studio-redesign (dual-agent)

Total 29/40 (Good). P0: dispute choice vs approve contradiction; mockup data not backed by API. P1: video comparison below fold / too small on mobile. P2: accent overuse + red dispute; accessibility (contrast #888 3.37:1, 9.5–11px labels, no reduced-motion/focus/viewport meta). P3: inconsistent stepper/typography.

# Assessment A: Studio redesign design review

## Design-specificity verdict: the structure is written for this product, the styling is not
The visual layer is the standard "AI tool, editorial" look: cream #FAF9F6, Geist 300 display type, mono uppercase labels, a Newsreader serif accent, 4 px corners and no shadows. Swap the logo and it could belong to many other products.

The information architecture is genuinely specific to Studio:
- The dispute is asked as a question with two answers.
- The template contract is written in plain language.
- Script lines show a frame from the material as evidence.
- Cost is split into paid items vs pennies ("grosze").
- A strip shows which agents worked on the project.
- Recovery offers three actions, each with its cost.

Colour-as-meaning is the one distinctive visual idea, and it gets diluted (see P2).

## Nielsen heuristics (0–4)
| # | Heuristic | Score | Reason |
|---|---|---|---|
| 1 | Visibility of status | 4 | Status card, rounds, time spent vs limit and "czeka 19 min" appear on every project screen. |
| 2 | Match with real world | 3 | Polish is plain and jargon is swapped out. "Grosze", "Rozstrzygnij" and the "Za mówcą" chip are still slightly insider. |
| 3 | User control | 3 | Stop and abandon are everywhere. There is no undo after "Zatwierdź", and the mid-run note to the director can't be taken back. |
| 4 | Consistency | 2 | The stepper differs across screens: 5 mono steps in Analiza, 4 sans steps in Szablon, none in WToku and Film. The header shows "WRZESIEŃ" plus a square avatar in one place and "Wydano we wrześniu" plus a round one elsewhere. |
| 5 | Error prevention | 2 | The price is on the paid button, which is good. But in the Szablon dispute the user can pick "Jak chce krytyk" and then press Zatwierdź, and that choice is silently lost (see P0-1). |
| 6 | Recognition over recall | 3 | Frame markers and the slot overlay help. On mobile the template contract collapses into one-line summaries. |
| 7 | Flexibility | 2 | No keyboard shortcuts for approve/reject, no batch view of pending decisions, no "approve as usual" route for repeat users. |
| 8 | Minimal design | 3 | Calm overall, but Szablon runs about 3,300 px tall and the list of details repeats the contract. |
| 9 | Error recovery | 4 | Zatrzymany is exemplary: one line per problem, a recommended action, its cost, and "nie trzeba kupować ponownie". |
| 10 | Help | 3 | The "Jak to działa" page is strong. It is linked from the page, but there's no help in context (e.g. what the Odrzuć cost covers). |

## Cognitive load (4 of 8 items fail)
- **Single focus: fails on Szablon.** The status card and the "who worked here" strip (about 450 px) push the video comparison mostly below the fold at 1440×900.
- **Choices at a decision point: fails.** The Szablon decision card has 2 radio options, a textarea, 3 suggestion chips, Zatwierdź, Odrzuć and Porzuć, so 8 controls.
- **Progressive disclosure: fails on mobile.** Szablon collapses the contract but leaves no way to reach the original English text.
- **Working memory: fails.** The dispute is described in the red chip, the status sentence, the decision card, the "TU JEST SPÓR" frame and round 3, five times worded differently.
- **Passes:** chunking, grouping, visual hierarchy, and one-thing-at-a-time (Tresc, Zatrzymany).

## Emotional journey
- **Before paying:** reassurance is excellent. Tresc shows "Za zatwierdzenie zapłacisz 0,73", a limit bar, "Mieści się w limicie", and a button that carries the price ("Zatwierdź i nagraj · 0,73 USD").
- **Ending:** Film ends on a green "Gotowy do publikacji 8/10". Zatrzymany is calm rather than alarming ("Głos i prezenter są już nagrane").
- **The main peak turns anxious.** On Szablon a red "BRAK ZGODY AGENTÓW" chip marks what is a normal, designed outcome. Red then means both "error" and "your call".
- **Analiza:** "Zawołamy Cię" promises a notification path (tab badge, email, Telegram?) that isn't designed anywhere.

## Strengths
1. The dispute is turned into one concrete question with the critic's and the director's positions. That is the best idea in the set.
2. Money is always shown in context: paid vs pennies, spent / this step / limit, and the price on the button.
3. The Zatrzymany recovery screen offers three costed options with one recommended, and says plainly that nothing will be bought again.

## Priority issues

### [P0] The dispute choice and "Zatwierdź" contradict each other
- **Why:** DESIGN.md sends the dispute choice as the `note` on reject only. Approve carries no note, so choosing "Jak chce krytyk" and then approving discards the choice without telling the user.
- **Fix:** Picking the critic's option changes the main button to "Popraw wg krytyka · ok. 0,04 USD" (a reject carrying the note). Picking "Zostaw tak" keeps "Zatwierdź szablon".
- **Command:** `/impeccable clarify`

### [P0] Many mockup elements can't be fed by api-types.ts
- **Szablon:**
  - No structured dispute options or positions; the API has only the strings `designCritique.disagreement` and `openDisagreements[]`.
  - No numeric per-slot cost (0,67 / 0,18 / "Razem ok. 0,85"). Slots only carry a `costNote` string, and `MoneyEstimate` exists only at the content gate.
  - No story beats with timings (`rationale` has no `story`), and `detailInventory` is typed `unknown`.
  - The rounds are English strings, so the Polish summaries need an extra translation step.
- **Analiza:** per-analyst results, progress, bounding boxes on the reference, and the timestamped live feed (the API only has `runs` and `timeline.steps`). The mid-run "Uwaga dla reżysera" note has no command.
- **Tresc:** no timing per sentence, no "skrócił z 16 do 11 słów", and "Usuń zdanie" / click-to-edit have no command.
- **Film:** the critic has no numeric score (8/10), and editor decisions have no before/after frames.
- **WToku:** no ETA ("za 4 min"), no live progress through the cuts, and no estimates for steps not yet run.
- **Zatrzymany:** issues have no frame, time range or measured values (47/40 s), and there's no cost estimate for "Popraw".
- **Main:** `ProjectSummary` has no per-project cost or thumbnail, and there's no monthly spend.
- **Shorty:** it's unclear whether `POST /api/shorts` accepts the 1:1 / 4:5 aspects, the framing mode and the limit.
- **Fix:** Annotate each mockup with the data it depends on and an empty-state fallback. Open a list of API gaps before implementation starts.
- **Command:** `/impeccable harden`

### [P1] The most important comparison isn't the first thing on screen
- **Why:** the user judges visually. Each video is 360×640, but the pair starts around y≈490 at 1440×900, so most of it is below the fold. On mobile each video is about 150 px wide, too small to judge caption weight ("Obróć telefon" is a workaround).
- **Fix:** Fold the "who worked here" strip into the status card and put the comparison directly under the title.
- **Fix:** Default the slot overlay to off, since its dashed labels cover exactly what the user is judging.
- **Fix:** Replace the HTML-rendered caption sample (it re-creates the style in web fonts) with real crops from `preview.frames` (reference vs preview).
- **Fix:** On mobile, stack the two videos with a shared scrubber, or add a swipe A/B view.
- **Command:** `/impeccable layout`

### [P2] The violet "your turn" accent is overused, and it is actually blue
- **Why:** #0007CB is ultramarine, not violet. Szablon uses it about 12 times: the chip, the stepper, the TY avatar, the dispute frame, the timeline markers, the HAK story beat and the caption swatch. The sample caption's blue highlight collides with it, Analiza uses it for the "NAPISY" box, and Main has five violet chips. The "max 1–2 per screen" rule is broken.
- **Fix:** Keep it to one signal per screen. Make the dispute amber or ink rather than red.
- **Command:** `/impeccable colorize`

### [P2] Accessibility gaps
- `#888` text measures 3.37:1 on canvas (navigation, upcoming steps), which fails AA.
- `#B8B8B8` measures 1.98:1 ("jeszcze nie" in Analiza), and the `#B98A2E` bar measures 2.96:1.
- Labels go down to 10.5–11 px mono uppercase.
- None of the screens has `prefers-reduced-motion` for the pulse and shimmer, and there are no focus-visible styles.
- **Command:** `/impeccable audit`

### [P3] Inconsistent framing and typography across screens
- **Why:**
  - The stepper changes wording and style across screens and is missing in WToku and Film.
  - Newsreader appears only on Analiza and Jak to działa.
  - Geist 300 at 56 px as the Analiza hero ("Agenci rozbierają wzorzec na części") reads like a marketing page in an operational flow.
- **Fix:** Use one ProcessStepper per mode (template / film) on every project screen. Keep project titles at 44 px and drop the serif, or use it only for agent quotes.
- **Command:** `/impeccable typeset`

## Persona red flags
- **Jordan (first-timer):**
  - 14 status and chip variants to learn.
  - "Grosze", "Rozstrzygnij" and "Za mówcą" need explaining.
  - The only onboarding is the "Pierwszy raz?" banner.
  - The pre-selected dispute option nudges without any explanation.
- **Sam (accessibility):**
  - The grey contrast failures listed above.
  - Mono 11 px uppercase with wide tracking.
  - Shimmer text.
  - Meaning carried by colour alone (a violet dot vs a black dot in the state chips).
  - No focus styles and no reduced-motion handling.
- **Casey (mobile):**
  - M-Zatrzymany has no "Obejrzyj film w obecnej wersji", so "Zaakceptuj mimo to" can be pressed without seeing the film.
  - M-Szablon drops "Porzuć" and "Oryginał (EN)".
  - The sticky "Zatwierdź" can be pressed without scrolling past the contract or the dispute.
  - The two videos are about 150 px wide each.
- **The creator who judges visually:**
  - The preview is covered by the slot overlay by default.
  - The caption "live sample" is not the real render.
  - The comparison sits under the fold.
  - The mockup's preview frame shows an empty blue presenter box, so the user can't judge "is the presenter visible".

## Minor observations
- The editor's "RUNDA 1" label appears twice in WToku (two issues in one round, but it reads as a duplicate).
- The Main list mixes state chips with stage names ("Analiza wzorca", "W toku · montaż") that aren't in the API state enum.
- The "Wydano we wrześniu 4,82 USD" monthly total has no API source.
- Film offers "Poproś o poprawkę" after completion, and its command mapping is undefined.
- Collapsed rows ("Dane techniczne · JSON") use a ▾ glyph but show no affordance on hover.
- Mobile Start chips wrap awkwardly in mono uppercase.

## Provocative questions
1. If a dispute is the expected outcome, why is it red, and why isn't the comparison video the decision card itself?
2. Would a creator trust "8/10" from a critic that the system admits can be unavailable ("brak oceny krytyka")? Should the score exist at all?
3. Should the Szablon screen open already playing both videos, with every other section collapsed until the user presses pause?

(No server was started; the detector wasn't run.)

# Assessment B: detector and browser evidence (studio-redesign)

Both mandatory steps ran. The HTML mockups were not modified: the md5 of all HTML files was the same before and after, and git status did not change.

## 1. CLI scan (`impeccable detect --json`)

- `studio-redesign/screens`: **exit 2, 218 findings** (215 warnings, 3 advisories). Every finding reports `line: 0` because the detector measures the rendered page. The file:line locations below come from grep.
- `studio-redesign/index.html`: **exit 0**, with 1 advisory: em-dash-overuse (12 em-dashes).

| Rule | Count | Where / source |
|---|---|---|
| undersized-ui-text | 86 | 9.5px (Analiza.html:39, table headers "TYTUŁ/OKIENKO/OSOBA/NAPISY"), 10px (M-JakToDziala:42,50), 10.5px (Analiza:46,48; JakToDziala:42; M-Analiza:20,34; Szablon:46; Tresc:43). Mostly 2-letter agent badges ("RE","KR","TY","SC"…), status chips ("Gotowe","Pracuje","Czeka"), and "przed"/"po" labels on Film |
| overused-font | 39 | Geist and Geist Mono on all 19 screens; Instrument Sans also on Szablon |
| cramped-padding | 28 | `<details class="acc">` with no top inset (Szablon, Tresc, Zatrzymany, M-Szablon ×5, Film); `.seg` (Shorty, Main, M-Shorty); `.pl` (Shorty ×4); `.crow` (JakToDziala); `section.card` (M-Szablon) |
| gradient-text | 27 | `.shim` rule (linear-gradient #111→#B8B8B8, background-clip:text, animated), inlined at ~line 37/41 of every screen and in tokens.css:83 |
| tight-leading | 15 | line-height 1.27 on ~12 screens; 1.19 on JakToDziala |
| all-caps-body | 8 | Analiza ×2, Film, JakToDziala, M-Start ×2, Main, Tresc (uppercase on 31–48 chars) |
| skipped-heading | 5 | JakToDziala h1→h3 ("Zatwierdzasz szablon"), h2→h4 ×2; M-JakToDziala h2→h4 ×2 |
| tiny-text | 3 | Szablon 11.5px body text |
| kicker-above-heading | 2 | JakToDziala ("Osobno" above h3), M-JakToDziala ("2 minuty czytania" above h1) |
| em-dash-overuse (advisory) | 2 | Main (12), Szablon (14) |
| pulsing-dot | 1 | Analiza:51 `.tdot` 6×6 infinite blink |
| side-tab | 1 | JakToDziala:47/90 `.st.dec` inset 3px stripe |
| repeating-stripes-gradient (advisory) | 1 | Szablon:183 |

## 2. Browser detect.js (live server injected into a new tab)

Setup:
- Static server on port 8766 (PID 69694), new tab tab-9.
- Preflight passed: changing document.title and appending a `<script>` both worked.
- `impeccable live-server --background` started (PID 69977, port 8400). `/detect.js` was injected into each page after scrolling to the top, with a 2.5 s wait.

The pane was only 678px wide, so the first Szablon run produced 23 findings, 13 of them `body-text-viewport-edge`. Those were artefacts of the narrow pane, so I re-ran every desktop page at 1440×900.

- **Szablon @1440:** line-length ×9 (~90–190 chars/line), undersized-ui-text ×3, tiny-text ×3 (11.5px), cramped-padding ×1 (0px vertical padding on a 14px button), ai-color-palette ×1 ("Cyan neon text on dark background"), overused-font (Geist 64%), em-dash-overuse (14), repeating-stripes-gradient.
- **Tresc @1440:** undersized-ui-text ×3, all-caps-body (48 chars), line-length ~90, cramped-padding (0px vertical, 15px text), overused-font (Geist 66%).
- **WToku @1440:** gradient-text ×3 (the shimmer is actually rendered here), line-length ~93, overused-font (Geist 54%).
- **Film @1440:** undersized-ui-text ×4 ("przed"/"po" at 10.5px), all-caps-body (38 chars), cramped-padding, overused-font (Geist 64%). The browser did not flag gradient-text here: the `.shim` CSS is present but no element uses it, while the CLI flagged the rule.
- **M-Szablon (mobile preset 375×812):** ai-color-palette ×1, overused-font (Geist 57%). Note that the layout viewport was 980px, not 375px, because the page has no viewport meta tag.

## 3. Objective checks (javascript_tool)

Contrast was measured on each visible text node against its effective background.

| Page | Contrast failures (AA) | Smallest fonts in use | Tap targets <44px | img without alt | Headings | Horizontal overflow at 375px |
|---|---|---|---|---|---|---|
| Szablon | #888888 on #FAF9F6 = **3.37:1** (inactive nav links "Szablony/Shorty/Jak to działa", 14px) | 10.5px ×3, 11px ×31, 11.5px ×5 | 12/23 (nav "Projekty" 76×20, chips 32px tall) | 0/2 | 1-2-2-2-2-3…, no skips | yes, scrollWidth 1440 |
| Tresc | same nav 3.37:1 | 10.5 ×3, 11 ×12, 11.5 ×9 | 6/15 (◉ 24×24, × 19×21, "Usuń zdanie" 133×36) | 0/5 | 1-2-2-3 ok | yes, 1440 |
| WToku | same nav 3.37:1 | 11 ×12 | 4/9 | 0/1 | 1-2-2 ok | yes, 1440 |
| Film | same nav 3.37:1 | 10.5 ×4, 11 ×5 | 4/15 | 0/12 | ok | yes, 1440 |
| M-Szablon | #00A6D6 on #3A3E4A = 3.77:1 (15px caption sample "more" inside the video preview) | 11 ×13, 12 ×5 | 3/14 (label 324×20, ◉ 24×24, × 19×21) | 0/2 | a single h2, no h1 | yes, 390 |

Other contrast pairs:
- The requested pairs pass: #585858 is 6.15:1 on #F1EEE9 and 6.76:1 on #FAF9F6, 5.82:1 on #E6E7FA.
- Status colours pass: #2F6B4F on #E4EEE7 is 5.3:1, and #A3261B on #F6E3DF is 5.95:1.
- #414141 did not appear on the pages tested.

375px iframe sweep of all M-* pages plus the desktop pages:
- **Every M-* page overflows by 15px** (scrollWidth 390 against 375). The cause is a root `<div style="width:390px;height:2140px;position:relative">`, a fixed iPhone-sized canvas.
- Desktop pages are fixed 1440 canvases and are not responsive.
- Tap targets under 44px on the mobile pages:
  - M-Start 5/15 (list links 20–24px tall, "Studio." 62×32)
  - M-Shorty 1/5 ("Zmień" 37×19)
  - M-Tresc 1/4 ("Usuń · −8 s" 98×40)
  - The others are 0.
- Smallest font on the mobile pages is 10px on M-JakToDziala, 10.5px on M-Analiza, and 11px elsewhere.
- **No file has `<meta name="viewport">`** (all 19 screens and index.html). On a real phone the M-* pages would lay out at 980px and be scaled down.
- All pages have `lang="pl"`.

## 4. Likely false positives

- **gradient-text (27):** this is a grey loading shimmer (#111→#B8B8B8) on in-progress labels, a functional loading state rather than decorative gradient text. It is a real issue only where it's used (WToku, Analiza). On the other screens it is an unused `.shim` rule copied into every file, which is duplicated CSS rather than a visual problem.
- **ai-color-palette / the 3.77:1 cyan:** a sample burned-in subtitle ("more", #00A6D6 at 30px/15px) inside the video-frame preview. It is content styling, not UI chrome.
- **body-text-viewport-edge:** appeared only at the 678px pane width and disappears at 1440.
- **Overflow and missing viewport meta:** the screens are static fixed-size mock canvases (1440 and 390). These matter only if the files are meant to be responsive or opened on a phone. The 390 frame overflowing a 375 device is still worth noting.
- **overused-font:** Geist and Geist Mono are the chosen system in DESIGN.md and tokens.css.
- **pulsing-dot:** a live-status indicator, so the animation is intentional.
- **Tap targets under 44px on the desktop pages:** a 44px minimum is a touch guideline, so these counts are advisory there.
- **undersized-ui-text badges:** the 2-letter agent monograms at 10.5px are borderline. The genuine problems are the 9.5px table headers (Analiza) and the 10–10.5px "przed"/"po" labels and status chips.
- **cramped-padding on `<details class="acc">`:** likely an accordion that deliberately sits flush against a top border rule, which is a design intent. Check it visually.

## 5. Skipped or failed steps

- **Skipped:** nothing mandatory was skipped.
- **Pane width:** the browser pane was 678px. Desktop pages were re-measured under 1440×900 emulation, then the viewport was reset to desktop.
- **Mobile emulation:** because there is no viewport meta, the mobile preset gave a 980px layout. True 375px overflow and tap-target checks were therefore done with same-origin 375px iframes.
- **`impeccable live-server stop`:** stopped the server but reported `config_missing` (`.impeccable/live/config.json`) when trying to remove its script tag. This is harmless because nothing was injected into any file (hash unchanged).
- **Leftover folder:** the live server left an untracked `/Users/janek/Documents/Aplikacje/video-watch/.impeccable/live/` behind. `.impeccable/config.local.json` already existed before this run.
- **Cleanup:** both servers are stopped (PIDs 69694 and 69977 are gone, ports 8766 and 8400 are free), and tab-9 is closed.
- **Raw detector JSON** is in the same scratchpad folder: det-screens.json and det-index.json.
