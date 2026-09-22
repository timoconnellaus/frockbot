# FrockBot product marketing context

Read this before any marketing work (copy, pages, launch posts, comparisons).
Decisions here were made by Tim on 2026-09-17; change them here, not in copy.

## What it is

FrockBot runs persistent Bots. A Bot holds a conversation, remembers across
sessions, runs on a schedule, uses a cloud computer of its own (browser,
files, terminal), writes tools and plugins that extend it, talks and listens,
and works inside connected apps (Gmail, Calendar, Drive, GitHub, Slack,
Notion). One web + Mac + phone client (the phone app sideloads from GitHub releases; it is not in a store). Hosted at
frockbot.com for US$20/month (US$15 credit included), or self-hosted into
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
  same code as the hosted deployment; US$20 or free vs the US$200 category.
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

- US$20/month, US$15 credit included, top-ups US$10/25/50, computer
  US$2.75/active hour, 100 GB idle storage included, no overage bills.
- 40 model providers built in; OAuth sign-in where a provider offers it.
- Voice: composer dictation plus a continuous voice session across all Bots.
- Connected apps: Gmail, Google Calendar, Google Drive, GitHub, Slack, Notion.
- Mac app download at /download/mac. Phone app sideloads as frockbot.apk on GitHub releases.
- Self-host: `bun run setup`, Workers Paid + a zone + Zero Trust + Fly token.

## Things not to claim

- Phone app availability in an app store (sideload from GitHub releases only).
- Named integrations beyond the six above.
- Any usage numbers, testimonials or star counts (none yet).
