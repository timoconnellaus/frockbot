---
status: accepted
---

# A Bot template is a recipe, and it carries no Memory

GrokBot's `create_bot_share_json` packs a bot into a shareable template whose sections are `profile`, `memory[]`, `skills[]`, `routines[]`, `plugins[{pluginId}]` and a `visibility` of `team` or `public` (`docs/research/grokbot-computer.md` lines 319-325). FrockBot's `BotTemplateV1` matches it section for section with three deliberate departures.

**Memory is not exported at all.** GrokBot's `memory[]` carries the bot's own remembered facts into a template that its own tool description calls _public shareable_. FrockBot's Memory is Markdown under durable roots, sharded per writing Bot, holding whatever a User has told their Bots across every Session — the address they live at, who their accountant is, what went wrong last quarter. A template crosses to a stranger, and a User packing one is thinking about the recipe, not auditing years of remembered facts for the one line they would not put on a web page. There is no scrub that makes that safe, because the danger is not a syntax the scrubber could recognise. So the section does not exist: `decodeBotTemplateV1` refuses a document carrying `memory`, and the export path never reads a Memory root. The cost is real parity loss — an imported Bot starts with the recipe and none of the knowledge — and it is the right trade, because the failure mode on the other side is disclosing a User's private facts to whoever holds a link.

**A marketplace `pluginId` becomes `packageId` + `catalogId` + `version`.** FrockBot has no numeric marketplace id, and an install must validate against an immutable, content-addressed Catalog generation. A template therefore names what the _importing_ User looks up in their own pinned generation; a `catalogId` absent from that generation is a missing line on the review card, never an install off a moved index.

**Publication is a User act, so visibility is not a tool argument and not in the blob.** "Publication beyond the authoring User is a User action" (`AGENTS.md`). The Bot's `bot_export_template` stages at `visibility: "private"` and reports what it packed as an `agent-card`; choosing `link` or `public` is a click in Bot settings. Visibility lives in the User Durable Object's `TemplateShareRecordV1` rather than in the document, because the document is content-addressed and immutable — it can never be un-published — while a share must be revocable. A share id is `<publicUserId>.<random>`: the first half routes an unauthenticated read to exactly one User Durable Object with no global index, and the second half is the capability, because a content hash alone is guessable by anyone holding the same content.

## Consequences

Two smaller rules follow from the same reasoning and are recorded here rather than in their own ADRs. A template carries the Bot's own `SheepRecipeV1`, which is four layer ids and nobody's photograph. And a template document carries no `createdAt`: the bytes must be a pure function of the Bot they describe, so that re-exporting an unchanged Bot lands on the same key and writes nothing. When a share was packed is share metadata, and it lives on the share record, which is mutable state anyway.
