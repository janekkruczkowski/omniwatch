# Cloning a video, and making a different one in its shape

This is the part of OmniWatch that takes a video apart into something a machine can
rebuild, and then rebuilds it — either as itself, or with a different subject.

Written down because the reasoning is not obvious from the code, and because most of the
decisions here were forced by a measurement rather than chosen from taste.

## The shape of it

```
a video
   │
   ├─ watch  (mode "blueprint")   → WHERE everything is, WHAT it is made of, WHERE its
   │                                content comes from
   ├─ watch  (mode "screentext")  → every word written on screen, when it changed, and
   │                                which word inside it is set apart
   ├─ listen (ElevenLabs)         → every spoken word, to the hundredth of a second
   │
   ├─ verify                      → the blueprint's rectangles drawn on real frames and
   │                                checked, three looks, agreement required
   ├─ captions                    → the screen decides the words, the soundtrack the clock
   ├─ episode                     → same slots, new values, for a different subject
   │
   └─ produce                     → each slot filled the way it says, then a HyperFrames
                                    project, then the existing renderer
```

Every step is its own endpoint under `/api/omniwatch/`, and every one takes and returns a
blueprint, so any of them can be skipped or run twice.

## The blueprint

Our own schema (`omniwatchBlueprint.ts`), version `omniwatch.blueprint/1`. A capture is
**regions** — places on the canvas, as fractions, with a paint order — and **tracks** —
what appears in a region and when.

What a region carries beyond its rectangle:

| field | why it exists |
|---|---|
| `role` | six layout functions, not genres: backdrop, figure, overlay, text, panel, cell |
| `grid` / `parent` / `at` | a divided panel and the cells that address it. Without this a tier list is a *picture* of a tier list and nothing can be placed into it |
| `paint` | the region's own surface: fill, corner, border. A tier row IS a coloured rectangle; asked to GENERATE one, an image model returned a photograph of a whole tier list squeezed into one row |

What a track carries:

| field | why it exists |
|---|---|
| `varies` | `fixed` is the format, `episode` is this subject. Marked at watch time because the model can see which is which and a later pass cannot |
| `fill` | `draw` / `generate` / `cut` / `supply` — where the content comes from. This was being inferred from the kind, and inferred wrongly |
| `style` | how words are set: colour, plate, stroke, weight, size as a fraction of the canvas, case, alignment, emphasis, and the SHAPE of the lettering |
| `items` | one per appearance, with `start`, `end`, `value`, and `beat` for the repeating unit |

Two distinctions that cost a film each:

- A **plate** and a **stroke** are different. A plate is visible between the letters; a
  stroke only touches them. A capture reported both for a caption that had only a stroke,
  and drew a black bar across a frame that had none.
- **Lettering** is recorded as a shape (`display`, `sans-condensed`, `slab`, …) and never
  as a font name. A vision model can honestly see "heavy geometric"; it cannot honestly
  see "Montserrat Black", and a guessed family name would be a model-authored string going
  into a stylesheet.

## Where a slot's content comes from

`fill` is the decision that makes this general rather than tier-list-shaped.

- **draw** — the renderer makes it out of the blueprint: words, colours, a coloured row, a
  bordered card. Free, exact, re-renderable. Every structural graphic is this.
- **generate** — a model invents a picture or a clip that does not exist: a presenter, a
  set, a joke image.
- **cut** — it already exists inside the analysed video: a demo, a replay, the thing being
  reacted to. Generating a lookalike would be both worse and dishonest. On a screen-
  recording format the model chose this unprompted.
- **supply** — a file that must be the genuine article: a logo, a real person's photograph.
  Left empty and NAMED, because the only thing worse than a missing logo is an invented one.

`produce` walks the blueprint and does exactly what each track says, and nothing it does
not say. `cutSupplies` turns the supply slots into cuts, which is what a reproduction of
THIS video wants and what a new episode must not do. `onlyRegions` limits generation to
named regions and takes the rest from the source.

## Two instruments, one timeline

The tools this is measured against drive captions from word-level ASR and look at frames
only at decision points, because frames are expensive for them. This project's omni model
takes the video's audio as well as its picture, so both measurements are affordable — and
they answer different questions.

- What is **written** can only be seen. The caption is usually shorter than the sentence,
  a title sits there in silence, a number ticks up, one word is in a box.
- **When** a word lands can only be heard accurately. The vision pass placed a cue at
  0.50–1.40 that an aligner placed at 0.08–1.30: late by four tenths, because it reads
  sampled frames.

So the screen decides the words and the mark; the soundtrack decides the clock. A cue whose
words are in neither — a label, a price, a watermark — keeps the times it was seen with
rather than being dropped. On the reference, 24 of 24 cues snapped.

## Checking the capture

A capture is a claim. It used to go straight into a render unexamined, which is how a
caption band ended up ninety pixels above the caption and an inset card at twice its size.

`verify` draws each region's rectangle onto real frames, each in its own colour, shows the
model that picture with a legend, and asks one narrow question per region. Corrections come
back as rects and go through the same validator as everything else.

Three rules the pass needed, each from a measurement:

- **Agreement.** The same capture checked twice gave three corrections and then none. A
  correction now needs two looks that object AND point at nearly the same rectangle; the
  applied rect is their average. A single objection is reported as `suspected`, not applied.
- **Siblings.** It fixed the C and D tier labels for being too narrow and waved through S,
  A and B — identical cells in the same column. The grid already says those five are one
  column, so a correction reaches the siblings that shared the measurement.
- **Tiling.** It corrected two slot cells to start at 0.247 while passing the labels beside
  them at 0.18 wide. A grid tiles; a corrected edge outranks a passed one, because a pass
  is only the absence of an objection.

And one rule about text: a text area takes the POSITION a correction gives it but keeps its
size unless the correction is larger. It "corrected" a caption band to the bounding box of
the words on screen at that instant, which would have made every longer line overflow.

## Measured limits

- Full-resolution frames sent to the checker ran past three minutes and timed out; 540px
  wide answers in four seconds. A 4000-token ceiling let the model ramble to the deadline;
  1500 returns in thirty-four seconds.
- Wan refuses `1:1` ("aspect_ratio is not within the range of allowed options"). Grok
  refuses clips under six seconds. Each model declares the frames it actually renders.
- Generators answer in their own length. A five-second clip in a twenty-second slot leaves
  the last fifteen frozen, so a short clip is looped to fill its slot.
- The dev server keeps jobs in memory. Re-installing the module while an analysis is
  running loses it.
