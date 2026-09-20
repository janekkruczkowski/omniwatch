

## Q3/Q4 retry — ymgH8jS6Wb8 "I Tested Jev on 12 Real Use Cases. My Honest Thoughts." (968s, fps 2)

Calling PROSE variant...
  status 200, 181576 in / 1255 out
Calling JSON variant...
  status 200, 181512 in / 3566 out

### PROSE variant — raw output
```
# Video Analysis

**hook_type:** cold demo — [0:00] "So Jev is literally everywhere and I think it's going to change how AI automations are built."
**hook_proof:** screen recording — [0:09] Shows Chrome extension labeling X tweets in real-time.
**information_lives_in:** both same thing — [2:50] Speaker explains speed while showing bar charts comparing models.
**pace:** ~1 cut per 3-5s; longest continuous screencast segment runs several minutes.
**on_screen:** talking head, screen recording, charts, text cards
**captions:** none — No burned-in subtitles detected throughout the video.
**payoff_lands:** midway — [4:47] Delivers detailed breakdown of use cases after establishing the core concept.
**asks_viewer_to:** link in bio — [4:56] Promotes free SOP for getting first AI automation client via description link.
**floor_to_reproduce:** camera and lighting — Requires clear studio setup with neon sign backdrop and high-quality audio capture.
**load_bearing_choice:** Structuring the entire review around live dashboard demonstrations rather than abstract explanations to prove cost/speed claims visually.

## Beats

*   **[0:00]** Intro & Hook: Presenter states Jev will change AI automation building; teases testing on 12 use cases and comparing speed/cost against other models.
*   **[0:09]** Live Demos Preview: Quick cuts show a Chrome extension auto-labeling X tweets ("Breaking", "Golden Nuggets") and an automated Bitcoin trading bot making second-by-second decisions.
*   **[0:42]** Concept Explanation: Defines Jev as an AI that makes structured decisions (Yes/No, Pick One, Score) without generating conversational tokens or writing summaries. References Diogo Almeida’s RLCD announcement tweet.
*   **[2:50]** Performance Metrics: Displays TypeSafe blog charts proving Jev is significantly faster (seconds vs minutes) and cheaper ($0.09 vs $62 for 1k emails) compared to GPT-5.6 Luna/Terra/Sol/Astra.
*   **[3:30]** Limitations & Strategy: Clarifies context window limits (64k tokens); proposes hybrid workflow where Jev sorts massive data piles cheaply before passing filtered subsets to expensive frontier models like ChatGPT for deep analysis.
*   **[4:56]** Sponsorship/Promo Break: Inserts call-to-action for a free "First Client SOP" PDF download linked in the description.
*   **[5:28]** Use Case 1 - Email Classification: Walkthrough of custom dashboard classifying 1,000 recent emails into categories like Invoice/Receipt, Brand Deal, Scam/Phishing using Yes/No logic and confidence scores. Compares execution time (~70s serial vs ~6s parallelized).
*   **[8:35]** Use Cases 2-4 - Content Routing: Demonstrates sorting YouTube comments by sentiment/intent, categorizing School posts by churn risk/experience level, and analyzing meeting transcripts for action items/tension levels.
*   **[10:16]** Real-Time Production Example: Revisits the X feed Chrome extension, scrolling through live posts being instantly tagged as "AI Slop" or valuable insights based purely on text classification.
*   **[11:58]** Advanced Workflows: Shows video clip hook-strength scoring, contract vetting for red flags/clauses, lead qualification filtering, brain-dump routing (ideas/tasks/journals), and customer support ticket urgency assessment.
*   **[14:13]** Trading Bot Deep Dive: Analyzes the paper-trading POC interface updating every second with price direction probabilities (Up/Unclear/Down) and executing buy/sell orders automatically despite fee structures outweighing model costs.
*   **[15:47]** Conclusion & Outro: Summarizes strategic value of asking right questions to leverage fast/cheap decision engines; advises running evals against golden datasets before trusting outputs; signs off requesting likes/subscriptions.

## On-screen text

*   **[0:00]** AIS (Neon Sign Background)
*   **[0:02]** Your most recent emails... Classifying... Invoice or receipt / Brand deal / Scam or phishing
*   **[0:09]** Breaking news / Golden nugget / AI slop (Chrome Extension Labels)
*   **[0:25]** Holding Bitcoin / Selling Bitcoin / Price up 2% / Unclear 89% / Price down 9%
*   **[0:42]** Jev, made simple / An AI that makes decisions and never writes a word.
*   **[1:08]** Reinforcement Learning for Calibrated Decisions (Highlighted Tweet Text)
*   **[2:50]** Speed / Seconds per task, TypeSafe's own test / Jev 0.4 sec / GPT-5.6 Terra 16.1 sec
*   **[3:11]** Cost / Monthly cost, 10,000 decisions a day / Jev $10 / GPT-5.6 Astra $2,700
*   **[3:30]** What it cannot do / Write or summarize / Find themes / Explain why
*   **[4:56]** Yours Free: An SOP for Getting Your First AI Automation Client
*   **[5:28]** Questions / Is this email an invoice, payment confirmation, or billing notice?
*   **[7:51]** Sponsor fit / Not a sponsorship inquiry at all / Weak fit / Good fit / Strong fit
*   **[10:16]** x.com/home (Browser URL Bar during scroll demo)
*   **[14:13]** Jev is trading Bitcoin / Profit/Loss -$26.00 / Right now Waiting in cash
```

### JSON variant — raw output
```
{
  "card": {
    "hook_type": {
      "value": "bold_claim_plus_demo_tease",
      "ts": 0.0,
      "evidence": "He opens by saying \"Jev is literally everywhere\" and that it will change how AI automations are built, then immediately teases tests across 12 use cases plus custom tools he built."
    },
    "hook_proof": {
      "value": "screen_recorded_examples_and_live_results",
      "ts": 1.3,
      "evidence": "The intro backs the claim with quick screen captures of an email classifier dashboard, a cost comparison chart, an X feed extension labeling posts, and a Bitcoin trading interface updating in real time."
    },
    "information_lives_in": {
      "value": "spoken_explanation_supported_by_slides_and_software_ui",
      "ts": 42.5,
      "evidence": "After the teaser, he shifts into explanation using slides like \"Jev, made simple,\" TypeSafe pages, speed/cost charts, and then detailed walkthroughs inside his own dashboards and extensions."
    },
    "pace": {
      "value": "slow_setup_then_dense_case_by_case_walkthrough",
      "ts": 286.9,
      "evidence": "The first few minutes explain what Jev is; from around 4:47 onward he moves through one concrete use case after another—emails, YouTube comments, school posts, X feed, meetings, clips, contracts, leads, brain dumps, support tickets, paper trading—with little dead space between them."
    },
    "on_screen": {
      "value": "talking_head_bookends_with_long_screencasts_and_pip_webcam",
      "ts": 42.5,
      "evidence": "Full-screen host appears at the start, middle transitions, and end; most of the runtime is desktop capture with a small webcam box in the lower-left while he narrates over slides, websites, X, and custom dashboards."
    },
    "captions": {
      "value": "none_visible",
      "ts": 0.0,
      "evidence": "No burned-in subtitles appear during the talking-head or screencast sections; emphasis comes from visible UI text, highlighted phrases on slides, and occasional overlay labels such as \"batches*\"."
    },
    "payoff_lands": {
      "value": "when_to_use_jev_vs_chatgpt_and_cost_speed_implications_for_production_workflows",
      "ts": 267.4,
      "evidence": "He crystallizes the lesson with a slide contrasting \"Reach for Jev\" against \"Stay with ChatGPT,\" then spends the rest of the video proving those categories with benchmark runs, dashboards, and a live trading POC."
    },
    "asks_viewer_to": {
      "value": "grab_the_free_first_client_SOP_and_like_the_video",
      "ts": 296.4,
      "evidence": "Mid-video he promotes a free SOP page titled \"Your Free: An SOP For Getting Your First AI Automation Client,\" and at the end says, \"please give it a like.\" He also points viewers to typesafe.ai waitlist access earlier."
    },
    "floor_to_reproduce": {
      "value": "moderate_high",
      "ts": 10.0,
      "evidence": "A solo creator can copy the structure—host-to-camera intro, explainer slides, long screen demos—but matching this specific video requires building multiple custom interfaces, comparing model outputs, running benchmarks, and even wiring up a live crypto-trading proof of concept."
    },
    "load_bearing_choice": {
      "value": "anchor_every_abstract_claim_in_a_specific_dashboard_or_workflow_he_actually_built",
      "ts": 329.2,
      "evidence": "Instead of staying conceptual, he repeatedly shows exact classification panels, edit-question modals, run times, costs, feeds, and trade logs, making the credibility come from demonstrated artifacts rather than opinion alone."
    }
  },
  "beats": [
    {
      "ts": 0.0,
      "text": "On camera in front of shelves, plants, awards, and a glowing AIS sign, he says Jev is \"literally everywhere\" and could change how AI automations are built. Quick cutaways preview an email-classification dashboard, a monthly-cost comparison, an X feed being labeled by a custom extension, and a Bitcoin trader reacting second by second."
    },
    {
      "ts": 42.5,
      "text": "He switches to picture-in-picture over slides and explains that Jev is not a chat model but an AI that makes decisions without writing tokens. The visuals move from \"Jev, made simple\" to Diogo's announcement post about RLCD and TypeSafe's System One Model page, including mentions of early access, Vercel, and OpenRouter."
    },
    {
      "ts": 92.0,
      "text": "Using a sample ticket diagram and then three decision cards, he breaks down the output types: yes-or-no with confidence, pick-one category with confidence, and score scales. He emphasizes that users define the criteria themselves and frame Jev as calibrated structured output rather than conversation."
    },
    {
      "ts": 160.7,
      "text": "He returns to the announcement thread and highlights the claims of being much faster and cheaper, then cuts to bar charts for latency and monthly cost versus Terra, Luna, Sol, and Astra. A limitations slide follows, stressing that Jev cannot write, summarize, find themes, do deep analysis, handle images/video, and has only a 64K context window."
    },
    {
      "ts": 229.0,
      "text": "To show where that limitation matters, he uses a funnel-style example with thousands of YouTube comments: Jev sorts the pile cheaply and quickly, then a more expensive frontier model reads only the smaller subset that needs reasoning or drafting replies. This becomes the bridge into his practical guidance on when to route work to Jev instead of ChatGPT."
    },
    {
      "ts": 286.9,
      "text": "Inside his own web app, he starts the hands-on section with emails. He demonstrates seven different rules already configured—invoice/receipt, brand deal, scam/phishing, email type, urgency, sponsor fit—and runs batches across 1,000 messages. He compares Jev against GPT-5.6 Luna, edits individual question definitions, toggles parallelization, and calls out timing and price differences directly on screen."
    },
    {
      "ts": 516.0,
      "text": "He repeats the same pattern on other content streams: YouTube comments get classified by comment type, reply-worthiness, sentiment, and difficulty; school/community posts get triaged by help needed, churn risk, member experience level, testimonial strength, self-promotion, and content idea value. Between examples he flashes usage graphs showing very low spend despite high request volume."
    },
    {
      "ts": 601.0,
      "text": "For real-time social filtering, he opens X and scrolls his feed while a Chrome extension stamps each post with labels like breaking news, golden nuggets, AI slop, video idea potential, and substance. He stresses that the backend judge looks at the text instantly as items enter the viewport, turning the abstract speed argument into something visibly happening live."
    },
    {
      "ts": 657.0,
      "text": "He pivots to internal operations dashboards: meeting transcripts categorized by call type, decisions made, action-step clarity, revenue relevance, waiting status, and tension; then short-form clip reviews scored for standalone posting viability, hook strength, quotable lines, and whether the screen is needed. His point here is that Jev does not analyze freely, but carefully chosen questions can aggregate into usable insight."
    },
    {
      "ts": 793.0,
      "text": "More production-oriented examples follow in rapid succession: contract vetting fields like risk tier and clause type, job/lead filters for quality and red flags, a voice-note router for tasks versus ideas versus journal entries, and customer-support routing based on issue, tone, priority, ownership, refund likelihood, and escalation need. These screens keep reinforcing the same workflow logic across domains."
    },
    {
      "ts": 853.0,
      "text": "As the climax demo, he shows a paper-trading Bitcoin bot driven by Jev reading price movement every second and deciding whether to hold, buy, sell, or stay unclear. Trade tables update continuously, fees dwarf the model cost, and a side panel contrasts daily inference expenses across models to argue that ultra-fast cheap decisioning is especially relevant for markets and other real-time systems."
    },
    {
      "ts": 958.0,
      "text": "Back on full-screen camera, he wraps by saying these examples should help viewers ask better questions and integrate Jev into workflows they actually care about. He asks for a like if people learned something new and signs off."
    }
  ],
  "on_screen_text": [
    {
      "ts": 1.3,
      "text": "\"Email\", \"Classifying\", \"Invoice or receipt\", \"Brand deal\", \"Scam or phishing\", \"Urgency\""
    },
    {
      "ts": 7.5,
      "text": "\"Cost\", \"Monthly cost, 10,000 decisions a day\", \"What it cannot do\""
    },
    {
      "ts": 10.0,
      "text": "\"AI slop\", \"Golden nugget\", \"Breaking\""
    },
    {
      "ts": 25.0,
      "text": "\"Jev is trading Bitcoin\", \"$1,000.00\", \"Holding Bitcoin\", \"Price up / Unclear / Price down\""
    },
    {
      "ts": 42.5,
      "text": "\"Jev, made simple\", \"An AI that makes decisions and never writes a word.\", \"What Jev is\""
    },
    {
      "ts": 58.5,
      "text": "\"RLCD = Reinforcement Learning for Calibrated Decisions\""
    },
    {
      "ts": 73.0,
      "text": "\"Introducing System One Models & Jev\", \"Join Waitlist\""
    },
    {
      "ts": 128.0,
      "text": "\"Three kinds of decisions\", \"Yes or no\", \"Pick one\", \"Score\""
    },
    {
      "ts": 169.0,
      "text": "\"Speed\", \"Seconds per task, TypeSafe's own test\", \"Not scientific. Same task. Jev 8.4s, Luna 66.8s, Terra 67.9s, Sol 74.1s.\""
    },
    {
      "ts": 190.0,
      "text": "\"At 100 a day: Jev $0.10, Luna $0.55, Sol $11, Astra $27.\""
    },
    {
      "ts": 210.0,
      "text": "\"Write or summarize\", \"Find themes\", \"Explain why\", \"Math or dates\", \"See images or video\", \"Context window\", \"How much it reads at once. A token is about three quarters of a word.\""
    },
    {
      "ts": 229.0,
      "text": "\"In front of a big pile\", \"ChatGPT reads only the small piles 'What are these 453 stuck on?'\""
    },
    {
      "ts": 267.0,
      "text": "\"When to use it\", \"Reach for Jev\", \"Stay with ChatGPT\", \"Sources: TypeSafe launch post docs test results OpenAI pricing and model pages Viral report via TechCrunch The comment run is our own, Sept 18, 2025\""
    },
    {
      "ts": 296.0,
      "text": "\"AIS AUTOMATION SOCIETY\", \"Your Free: An SOP For Getting Your First AI Automation Client\", \"Send me the SOP\""
    },
    {
      "ts": 301.0,
      "text": "\"INSIDE THE PDF\", \"The exact steps hundreds of AIS+ members followed to get paid for AI automation, including...\""
    },
    {
      "ts": 329.0,
      "text": "\"aisplus.app\", \"Questions\", \"New\", \"Edit question\", \"Answer type\", \"Category\", \"Save\", \"Run\""
    },
    {
      "ts": 374.0,
      "text": "\"Spent so far: $0.70 on Jev, $2.30 on other models\", \"Compare cost\", \"GPT-5.6 Luna\""
    },
    {
      "ts": 394.0,
      "text": "\"batches*\""
    },
    {
      "ts": 418.0,
      "text": "\"Is this email a receipt, invoice, payment confirmation, or billing notice?\", \"Call it a yes when Jev is at least this sure\""
    },
    {
      "ts": 470.0,
      "text": "\"Sponsor fit\", \"Levels, lowest to highest\", \"Strong fit: A sponsorship inquiry from a well-known AI dev tool company that fits my audience perfectly.\""
    },
    {
      "ts": 516.0,
      "text": "\"YouTube comments\", \"Comment type\", \"Sentiment\", \"Question difficulty\""
    },
    {
      "ts": 554.0,
      "text": "\"School posts\", \"Needs a team answer\", \"Churn risk\", \"Testimonial strength\""
    },
    {
      "ts": 601.0,
      "text": "\"X Feed\", \"Breaking vs noise\", \"Video idea potential\", \"Substance\""
    },
    {
      "ts": 657.0,
      "text": "\"Meetings\", \"Meeting type\", \"Decision made\", \"Action item clarity\", \"Tension\""
    },
    {
      "ts": 719.0,
      "text": "\"Video clips\", \"Hook strength\", \"Clip type\", \"Audience benefit\", \"Quotable line\""
    },
    {
      "ts": 793.0,
      "text": "\"Contract vetter\", \"Risk tier\", \"Clause type\", \"Revenue or equity cap\""
    },
    {
      "ts": 804.0,
      "text": "\"Job and lead filter\", \"Lead quality\", \"Red flags\", \"Next pressure\""
    },
    {
      "ts": 809.0,
      "text": "\"Brain dump router\", \"Has a deadline\", \"Priority\", \"Two-minute task\""
    },
    {
      "ts": 833.0,
      "text": "\"Customer support\", \"Route to\", \"Escalation\", \"Refund likely\"", "Wants money back"
    },
    {
      "ts": 853.0,
      "text": "\"Jev Trader\", \"Jev is trading Bitcoin\", \"Trades\", \"Rules\", \"Cost of the AI decisions\""
    },
    {
      "ts": 958.0,
      "text": "no additional readable overlay beyond persistent room branding \"AIS\""
    }
  ]
}
```

JSON variant parses: no (Expected ':' after property name in JSON at position 12628 (line 220 column 5))
Degeneration hits — prose: 0, JSON: 0
Output length — prose: 4959 chars / 1255 tokens, JSON: 12898 chars / 3566 tokens

This retry's cost: $0.0567 (363088 in / 4821 out tokens)