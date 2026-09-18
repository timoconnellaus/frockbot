# What a Plugin must be able to build

FrockBot's premise is that it becomes exactly what one person needs it to be.
Not an assistant that helps with the tool — the tool. A plumber's FrockBot is a
quoting and job app that happens to have a Bot in it. A recruiter's FrockBot is
an applicant tracker. Neither of them installed a different product, and
neither of them wrote code.

This file is the bar. Each scenario is a person turning FrockBot into something,
described by what is true when it works. They are deliberately whole products
rather than features, because a feature list can be complete while the thing a
person wanted is still impossible to assemble. The platform is finished for a
scenario when a Bot can build that scenario from a conversation, and not before.

The scenarios are not a roadmap and nothing here is a commitment to build a
particular product. They are the test set the extension points are designed
against: when a decision about Plugins is open, the question is which of these
it makes possible and which it forecloses.

## How to use this

Every scenario names its **done when**, which is observable from outside, and
**what it pushes**, which is the platform surface it leans on. The scenarios
share a single acceptance line:

> A person who does not write code described a need in conversation, and the
> app on their phone, their Mac and the web now looks and behaves like that
> tool. It kept working while the app was closed. It grew when they asked for
> more. No FrockBot release happened in between.

## The scenarios

### 1. The tradie

Marco is a plumber. He asks for a website and somewhere to run his quotes.

**Done when** his Bot has built and deployed a site on his own domain; the
quote form on it delivers into FrockBot with the customer's photos attached;
a Quotes surface his Bot designed lists them; Marco taps one and the Bot drafts
the quote from his price list for him to approve; accepted quotes become jobs
on a Jobs surface and blocks on his calendar; finished jobs become invoices
that chase themselves and reconcile when paid; the home view of his app is
today's jobs; the phone widget shows the next one; sharing a photo from his
camera roll files it against the job he is on.

**Pushes** deploying to a third-party host, public inbound data, Bot-built
surfaces over structured data, payments, SMS, calendar writes, native share
and widgets.

### 2. The studio

Priya teaches pottery and wants to sell classes.

**Done when** a public booking page shows real availability drawn from both of
her calendars; deposits are taken; a cancellation promotes the next person off
the waitlist without her; reminders go out the day before; and on class morning
her phone opens on a roll-call surface with one tap per attendee. A student who
sends a photo of their pot has it filed against their record.

**Pushes** public pages backed by live data, payments, logic that runs on a
trigger rather than in a Turn, a phone-first surface, per-customer records.

### 3. The landlord

Dave has four rentals and wants the tenant side handled.

**Done when** a tenant's text or web form becomes a maintenance request; the
Bot asks its clarifying questions over SMS; it dispatches to a tradie; when
that tradie is Marco from scenario 1, the request reaches his FrockBot as a
quote request and his answer comes back into Dave's; rent reminders and lease
renewals run themselves; and an inspection is a checklist on Dave's phone with
photos attached as he walks.

**Pushes** inbound SMS, Bot-to-Bot across two Users with consent, approvals,
recurring work, a camera-bearing surface.

### 4. The recruiter

Aisha wants her candidates tracked.

**Done when** a candidate's reply in Gmail wakes the Bot; a board surface moves
them by stage; interviews are booked against her calendar with links; the night
before, a voice conversation preps her from the candidate's file; and her
client reads a weekly digest on a link that needs no FrockBot account.

**Pushes** connected-app events as triggers, a rich interactive surface,
calendar writes, voice over one Bot's context, read-only publishing.

### 5. The podcast

Sam records interviews on his Mac.

**Done when** the Mac captures the call; the Bot transcribes it, cuts chapters,
writes the notes, renders the art, uploads to his host and schedules the posts;
and a stats surface pulled from the host's analytics greets him each morning.
The heavy audio work runs on the Bot's Computer, not his laptop.

**Pushes** desktop audio capture, the Computer as a worker outside a Turn,
publishing through someone else's API, a dashboard surface.

### 6. The household

Two Users, one family.

**Done when** both phones show the same calendar, the chores widget, and a
shopping list either can edit; a receipt photographed by one appears for the
other; arrival at school notifies the other parent; the kid's homework Bot
reports up to the parents; and pickups can be arranged by voice in the car.

**Pushes** data shared between two Users, widgets on both phones, location
triggers, a delegated Bot reporting to another, voice.

### 7. The indie operator

Lena runs a small SaaS alone and wants ops and support covered.

**Done when** a monitoring alert runs a playbook on the Computer with no Turn
and no human; she is paged only when that fails; support mail and a chat widget
embedded on her own site both land in one support surface; the knowledge base
the Bot grows from resolved tickets is public; refunds wait for her approval;
and the status page maintains itself.

**Pushes** triggers that drive the Computer, public surfaces that change from
events, an embeddable widget on a third-party origin, approvals, paging.

### 8. The coach

Ben is training for a marathon.

**Done when** his plan adapts weekly from his watch and phone health data; the
morning check-in is a spoken conversation; rest days nudge him; and he can put
the whole thing in a mode where the reasoning runs on-device and nothing about
his body leaves the phone.

**Pushes** health permissions with real consent, a local model path, wearable
data, adaptive scheduled work.

### 9. The tutor

Yuki is learning Spanish.

**Done when** the daily lesson is a voice conversation; a deck surface holds
her spaced repetition; today's phrase is on her lock screen; and she can
select text in any app and have it explained by her tutor Bot.

**Pushes** voice as the primary surface, widgets, a share target, adaptive
storage.

### 10. The event

Tom runs a 300-person conference.

**Done when** the public site sells tickets and collects speaker submissions;
attendees get an app that is FrockBot wearing the event's clothes — schedule,
map, announcements; volunteers check people in with a phone camera; day-of
announcements push to everyone; and the survey goes out afterwards.

**Pushes** FrockBot reshaped for people who are not its Users, ticketing,
camera scanning, push to many, many devices at once.

### 11. The networker

Nadia wants to keep in touch with people properly.

**Done when** her phone's contacts and calendar feed the Bot; every meeting
leaves a record; a follow-up queue surfaces who is overdue; birthdays and
90-day silences raise themselves; each meeting ends with a drafted note to
approve; and "log that I met Chris" works from Siri.

**Pushes** on-device contacts and calendar, meeting capture, assistant intents.

### 12. The agency

A freelancer wants a team.

**Done when** a researcher, a writer, an editor and a client-facing Bot pass
work between them; a board surface shows every piece of work and where it is;
each Bot has a budget; and the client sees one page per project without an
account.

**Pushes** multi-Bot orchestration inside one account, work made visible,
budgets, external read-only publishing.

## What the set demands

Read across the twelve rather than down them.

- **All twelve** need the shell to become the tool: a home view, navigation,
  naming and notification categories the Bot chose, not a chat window with a
  panel bolted on.
- **Eleven** need surfaces over structured data that a Plugin owns, richer than
  a settings section, identical on phone, Mac and web.
- **Nine** need something a stranger can reach: a site, a form, a read-only
  page, a widget on someone else's origin, an app for non-Users.
- **Eight** need waking on an event that is neither a cron nor a signed webhook:
  mail, calendar, SMS, location, health, an alert.
- **Six** need to act as the User on an account they connected.
- **Four** need something shared across two Users.
- **Three** need work to run on the Computer with no Turn attached.
- **Three** need a device capability the client does not have today, and half
  of them need an iOS app to exist at all.

The first two lines are why [ADR 0032](adr/0032-plugin-data-and-surfaces.md)
exists. The rest are named there as the horizontal expansion the architecture
has to survive without being redesigned.

## Adding to this file

A scenario earns its place by being a whole product someone would otherwise buy,
and by pushing a surface the existing twelve do not. Write the done-when so that
someone else could tell whether it works without reading the code.
