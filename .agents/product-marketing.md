# FrockBot product marketing context

**Document version:** v3
**Last updated:** 2026-09-27

Read this before any marketing work (copy, pages, launch posts, comparisons).
Decisions here were made by Tim on 2026-09-17; change them here, not in copy.

## What it is

FrockBot runs persistent Bots. A Bot holds a conversation, remembers across
sessions, runs on a schedule, uses a cloud computer of its own (browser,
files, terminal), writes tools and plugins that extend it, talks and listens,
and works inside 1,400+ connected apps (Gmail, Calendar, Drive, Slack,
Notion, Shopify and the rest). One web + Mac + phone client (the phone app sideloads from GitHub releases; it is not in a store). Hosted at
frockbot.com from US$5/month (Standard, US$20/month with US$20 credit
included, is the lead), or self-hosted into
your own Cloudflare account with one command. MIT licensed.

## Two audiences, two doors

**1. Everyday people (the homepage).** Literally consumers, not prosumers.
They do not know the AI space and should never need to.

- Jobs: life admin (quotes, forms, renewals), shopping (find it cheaper,
  watch a price), keeping track (tickets, school notes, listings), holidays.
- Vocabulary: "bot", "job", "hand it off", "comes back done". Never "agent",
  "model", "LLM", "harness", "plugin", "provider", "Durable Object".
- Fears to answer: it'll spend my money / send something (approvals);
  I'll have to explain everything again (memory); it's spying (open source,
  yours to keep); it'll run up a bill (bounded credit).
- Tone: warm, plain, a little playful (sheep, "no wool required"). Concrete
  outcomes over capabilities.
- Primary CTA: start the hosted product.

**2. AI enthusiasts (`/how-it-works/`, `/open/`, and the "For the tinkerers"
strip).** People who know the category and want to own and modify the thing.
`/how-it-works/` is titled **Inside FrockBot** (nav label **How it works**) and
carries the architecture and the capability reference.

- Angles: MIT open source; bring your own model (40 providers); everything
  is a plugin (hooks on the loop, tools, storage, declared egress, Bots can
  author plugins behind approval); one-command self-host on Cloudflare;
  same code as the hosted deployment; US$5 or free vs the US$200 category.
- Vocabulary: theirs — harness, provider, plugin, Durable Object, Worker.
- Primary CTA: read the install guide / star the repo.

## The rule that joins them

One product, two doors. The homepage is written for audience 1 end to end,
with two exceptions that name plugins on purpose: the "Makes its own tools"
feature card, and the Inside FrockBot card between the feature grid and the
work example — copy and bot-builder artwork in audience 2's vocabulary,
linking to `/how-it-works/`. Audience 2 self-selects through the primary
"How it works" and "Open source" nav links, the GitHub mark, that card, and
the short tinkerer strip near the bottom. Do not blend the vocabularies
anywhere else in one section.

## Pain points (audience 1) — draft, confirm with Tim

- **Core problem:** the small jobs that need a dozen tabs and a bit of
  patience — comparing quotes, watching a price, filling the same form,
  chasing a booking — pile up because none is worth an evening.
- **Why what they try falls short:** a chat assistant answers and then
  forgets; it cannot keep watch, come back tomorrow, or act in their apps.
  The always-on bots that can are built for professionals and cost ten
  times as much.
- **What it costs them:** overpaying (missed price drops, lazy renewals),
  missed deadlines and sales, and the low hum of a to-do list that never
  shrinks.
- **Emotional tension:** guilt about the pile; distrust of handing a
  machine their inbox or card.

## Differentiation — the two angles (Tim, 2026-09-27)

**1. Dress your Bot (the name).** FrockBot plays on "Grok bot": a frock is
something you put on, so the Bot is yours to dress. It is the one thing the
always-on category cannot show, and it is visual.

- Audience 1 hears **"make it yours"**: the same app in very different
  looks, and a Bot that adds the screen its job needs (a fare tracker beside
  the holiday Bot, a customer list beside the shop Bot). No word "plugin".
- Audience 2 hears the mechanism: themes, panels and tools are plugins, and
  a Bot can write its own behind your approval.
- Proof is a scrolling gallery of real screenshots: themes via the theme
  plugin, panels via real plugins. Chat content may be staged, but every
  surface shown must be UI the product actually draws.

**2. Transparency: see everything it did and everything it cost.** Answers
the biggest consumer fear ("it'll run up a bill", "what is it doing?").

- Every step on record; protected actions ask first; watch or take over
  its screen.
- The Spending page: how much of the month is left and when it runs out
  at this pace ("lasts until the 24th"), the share of the month each Bot
  and Routine uses, the biggest driver, a daily limit per Bot. Usage reads
  as a share of the plan, not a running dollar meter; dollars appear where
  money changes hands. When credit runs out, work pauses — no overage.
- Contrast with the flat US$200 plans: a live meter you control, from
  US$5.

## Switching dynamics — draft

- **Push:** the pile of put-off jobs; assistants that forget; paying for
  things they meant to cancel or compare.
- **Pull:** hand it off once and it comes back done; it keeps watch while
  they are out; it looks and works the way they want.
- **Habit:** "I'll just do it myself later"; already paying for ChatGPT.
- **Anxiety:** letting it near their money and inbox; a surprise bill;
  having to learn something technical.

## Objections

| Objection                                | Response                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "I already pay for ChatGPT."             | Connect it and your bots use it; FrockBot adds memory, routines, a computer and your apps.                                                                     |
| "Will it spend my money or send things?" | It finds the deal and hands you the link; you buy. Sending anything asks first, in the conversation, with a tap.                                               |
| "What will it cost me?"                  | US$20 a month with US$20 of usage included; Spending shows how much of the month each bot uses, with a daily limit per bot; it pauses rather than overcharges. |
| "Is it safe with my inbox?"              | Every step is on record; the code is open for anyone to check.                                                                                                 |
| "Sounds technical."                      | You talk to it. Nothing to set up.                                                                                                                             |

**Anti-persona:** teams buying for a company; people wanting a fully
autonomous agent with no check-ins.

## Competitors: allude, never name

Tim's decision (2026-09-17): no competitor is named anywhere on the site for
now. Refer to the category — "the always-on bots that cost ten times as
much", "the kind that usually costs US$200 a month". A `/compare/...` page is
a later decision, not a default.

## What the category says (research 2026-09-17)

Consumer/prosumer agents converge on: the "AI teammate/hire" metaphor,
"works while you sleep", "does real work in N,000 apps", "its own cloud
computer", approvals. None speak to actual consumers; all pitch
professionals. Open-source harnesses converge on: "yours" / "on your own
terms", "everything is a plugin", "any model", self-host and data
sovereignty, with "read the docs" as the CTA and GitHub stars as proof.

## Proof points that are true today

- Standard US$20/month with US$20 credit included (Plus US$50 with US$60;
  both with a 7-day trial); BYO US$5/month, no trial and no credit included,
  for people bringing their own models. Top-ups US$10/25/50, computer
  US$2.75/active hour, 100 GB idle storage included, no overage bills.
- 40 model providers built in; OAuth sign-in where a provider offers it.
- Voice: composer dictation plus a continuous voice session across all Bots.
- Connected apps: 1,400+ (the count is `CONNECT_APP_COUNT_V1` in
  `app/connect/catalog.ts`; round it down to the hundred). A Bot can use every
  tool an app has. Some sign in with a key the person pastes on the app's
  sign-in page rather than a one-tap sign-in.
- Mac app download at /download/mac. Phone app sideloads as frockbot.apk on GitHub releases.
- Self-host: `bun run setup`, Workers Paid + a zone + Zero Trust + Fly token.

## Things not to claim

- Phone app availability in an app store (sideload from GitHub releases only).
- A named app that is not in `app/connect/catalog.ts` (no Spotify, Xero or
  X today), or that works only for a business account as if it were the
  personal one (WhatsApp and Instagram connect Business and Creator accounts).
- The service behind connected apps, anywhere on the site.
- Any usage numbers, testimonials or star counts (none yet).
- That a Bot buys things for you. It finds the price drop and hands you the
  link; the person checks out. (Tim, 2026-09-27: not marketing purchases
  yet.)
- A screenshot of UI the product does not draw. Staged conversations are
  fine; invented screens are not.

## Changelog

_Newest first. One line per revision: what changed and why._

- v3 (2026-09-27) — Buying on the person's behalf moved to things not to
  claim; the spending objection now answers with the hand-off.
- v2 (2026-09-27) — Added pain points, the two differentiation angles
  (dress your Bot; see everything it did and cost), switching dynamics,
  objections and the screenshot rule; provider count 28 → 40 to match the
  site.
- v1 (2026-09-17) — Initial context: two audiences, competitors unnamed,
  proof points and claims to avoid.
