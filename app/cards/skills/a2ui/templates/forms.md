# Forms

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

Use an input when you genuinely need a value the User has to compose — a name,
a date, an amount, a choice among more than a handful of options. For one
question with two to six answers, a `widget` send is shorter and ends your Turn
cleanly; a card form earns its place when several values belong together, or
when the form sits beside the thing it is about.

Keep a form to a few fields. Every field is a thing the person has to read.

**Never a password, a card number or any other secret.** Whatever is typed into
a form reaches you and the conversation. Ask for a secret with a
`send_to_user` `secret-request` instead: the person types it into a field the
host draws, it is kept in their account, and you get a reference you can fill
into a web page; you are never given the value (`frock.md`, `SecretField`).

## How an input carries its value

Each input's `value` is **bound to the data model**, not typed in as a literal:

```json
{
  "id": "amount",
  "component": "TextField",
  "label": "Amount",
  "value": { "path": "/amount" }
}
```

Seed the model in the same send — `"dataModel": { "amount": "" }` — and the
renderer writes what the person types back to that pointer. A `DateTimeInput`
with nothing yet chosen is seeded with `""`.

Nothing reaches you until a control is pressed. So a form always ends in a
`Button` whose action name is yours (see `actions.md`), and that press is what
brings the answer back — as your next Turn's input, with what you put in the
action's `context`. If you need the whole form at once rather than field by
field, set `"sendDataModel": true` on `createSurface` and the surface's data
model travels with the press.

`ChoicePicker` is the one to reach for when the options are known: it does both
single and multiple selection, and its `value` binds to a **list** of strings,
even when only one may be chosen. `CheckBox` is one boolean. `Slider` is for a
number on a range the person can see the ends of.

## Components

<!-- components: TextField, CheckBox, DateTimeInput, ChoicePicker, Slider -->

## Validation and formatting functions

A function call is written where a value goes, and it resolves on the client:

```json
{
  "id": "total",
  "component": "Text",
  "text": {
    "call": "formatCurrency",
    "args": { "value": { "path": "/total" }, "currency": "AUD" },
    "returnType": "string"
  }
}
```

An input's `checks` take a boolean-returning call and the message to show when
it is false:

```json
"checks": [{ "condition": { "call": "required", "args": { "value": { "path": "/amount" } } }, "message": "Enter an amount." }]
```

`returnType` matters where the value's type is not `boolean`: a formatting
function used as a string wants `"returnType": "string"`.

Client-side checks are a courtesy to the person filling the form. They are not
a guarantee to you: check the value again yourself when it arrives.

<!-- functions: required, regex, length, numeric, email, formatString, formatNumber, formatCurrency, formatDate, pluralize -->
