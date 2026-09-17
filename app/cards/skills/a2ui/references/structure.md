# Structure

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

The frame of a card — what it is called, what state it is in, where one part
ends and the next begins — is worth components of its own. Each of these is
one component where composing the same thing by hand costs three or four, and
the host lays them out, so they cannot come out wrong at phone width.

- **`CardHeader`** — the top of almost every card: the title, an optional
  quiet line under it, and the state pill at the right. **Use this instead of
  a `Row` holding a `Text` and a `StatusPill`.** The host owns the layout, so
  the pill cannot be pushed off the edge on a phone however long the title is.
- **`SectionHeader`** — between the blocks of a longer card: "Attachments",
  "What changes". It draws its own hairline.
- **`Callout`** — one tinted note saying something that is not part of the
  thing itself: a consequence, a caveat, a permission that is missing. At most
  one per card.
- **`IdentityRow`** — a person or an account: avatar, name, second line. The
  sender of an email, the owner of a file, the account a connection is for.

## The header settles with the card

Bind `status` to the data model and the whole card settles with one
`updateDataModel`:

```json
{
  "id": "head",
  "component": "CardHeader",
  "title": "Reply to Nick",
  "subtitle": "nick@example.com · today",
  "status": { "path": "/status" },
  "tone": "ready"
}
```

Then, when the thing is done, one message moves it — and one more sets the
tone, if the tone changed:

```json
{
  "version": "v1.0",
  "updateDataModel": {
    "surfaceId": "draft-nick",
    "path": "/status",
    "value": "Sent"
  }
}
```

`tone` is not bindable: it is what the host colours by, so it is written on
the component, and changing it is an `updateComponents` naming the header
again.

## Tones mean the same thing everywhere

`neutral`, `ready`, `success`, `warning`, `danger` — the same five on
`CardHeader`, `StatusPill`, `Callout`, `Receipt`, `MetricTile` and
`ProgressBar`. `ready` is waiting on the person, `success` is done, `warning`
needs attention, `danger` failed. You name the tone; the app owns the colour,
so a card cannot paint itself into looking like something it is not.

## Avatars and links

`IdentityRow`'s `imageUrl`, like every link in every component, must be
`https://`. A card carrying anything else is refused whole, and nothing is
drawn. When there is no image, give `initials` — or leave it out and the host
takes them from the name.

## Components

### `CardHeader`

The top of a card: its title, an optional line under it, and the pill saying what state it is in. Prefer this to a Row of Text and StatusPill — the host lays it out so the pill can never be pushed off the edge on a phone.

| Property   | Type                                                       | Required | Binding  | What it is                                                                                                                                                           |
| ---------- | ---------------------------------------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`    | DynamicString                                              | yes      | bindable | What the card is about, in a few words. Two lines at most; the host truncates past that.                                                                             |
| `subtitle` | DynamicString                                              | no       | bindable | One quieter line under the title: who it is for, when it was made.                                                                                                   |
| `status`   | DynamicString                                              | no       | bindable | The words on the pill at the right, e.g. 'Ready to send'. Bind it to the data model and the card settles with one updateDataModel. Omit it for a card with no state. |
| `tone`     | `neutral` \| `ready` \| `success` \| `warning` \| `danger` | no       | literal  | What the state means, which is what the host colours the pill by. Defaults to 'neutral'.                                                                             |

```json
{
  "id": "root",
  "component": "CardHeader",
  "title": "…title…"
}
```

### `SectionHeader`

A small heading that divides a long card into parts, with a hairline under it. Use it between blocks, never as the card's own title — that is CardHeader.

| Property  | Type          | Required | Binding  | What it is                                              |
| --------- | ------------- | -------- | -------- | ------------------------------------------------------- |
| `title`   | string        | yes      | literal  | The section's name, e.g. 'Attachments'.                 |
| `caption` | DynamicString | no       | bindable | A short note at the right of the heading, e.g. a count. |

```json
{
  "id": "root",
  "component": "SectionHeader",
  "title": "…title…"
}
```

### `Callout`

A tinted note beside the thing the card is about: a warning, a consequence, a piece of context. One per card at most — a card that needs two is telling the person too much at once.

| Property | Type                                                       | Required | Binding  | What it is                                                                                              |
| -------- | ---------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `text`   | DynamicString                                              | yes      | bindable | What the person needs to know, in a sentence or two.                                                    |
| `title`  | DynamicString                                              | no       | bindable | An optional bold first line.                                                                            |
| `tone`   | `neutral` \| `ready` \| `success` \| `warning` \| `danger` | no       | literal  | What kind of note it is, which is what the host colours and which icon it draws. Defaults to 'neutral'. |

```json
{
  "id": "root",
  "component": "Callout",
  "text": "…text…"
}
```

### `IdentityRow`

A person or an account on one line: an avatar, a name, and a quieter second line. For the sender of an email, the owner of a file, the account a connection belongs to.

| Property   | Type          | Required | Binding  | What it is                                                                             |
| ---------- | ------------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `name`     | DynamicString | yes      | bindable | Who it is.                                                                             |
| `detail`   | DynamicString | no       | bindable | The second line: an address, a handle, a role.                                         |
| `imageUrl` | string        | no       | literal  | An https:// avatar. A card carrying any other scheme is refused whole.                 |
| `initials` | string        | no       | literal  | What the avatar says when there is no image. Defaults to the first letter of the name. |

```json
{
  "id": "root",
  "component": "IdentityRow",
  "name": "…name…"
}
```
