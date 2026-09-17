# Actions

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

A card that asks for nothing needs no action. Add one when there is something
the person can do about the thing the card shows — send it, choose one, retry,
open the source.

`Button` is the only component in the standard catalog that raises an action.
`ApprovalActions` in `frock.md` draws its own pair of buttons and names their
actions itself; that is the only other thing on a card that reaches the kernel.

Keep it to one or two controls. A card with six buttons is a menu, and a
sentence with a question is better than a menu.

## The action shape

```json
{
  "id": "confirm",
  "component": "Button",
  "child": "confirmLabel",
  "variant": "primary",
  "action": {
    "event": { "name": "send-draft", "context": { "draftId": "d-91" } }
  }
}
```

- `child` is the id of the component inside the button — a `Text` with the
  label, almost always. An `Icon` only when an icon is what was asked for.
- `action.event.name` is the whole of what the press means. Write it as
  `{ "event": { "name": … } }`; that nesting is what the app raises a press
  from.
- `context` is a JSON object that travels with the press. Use literals for
  static ids — `"draftId": "d-91"` — and a binding only for a value that must
  come from the data model.
- An action whose name is not a kernel namespace arrives as **your next Turn's
  input**: the surface, the name and that context, as something the card
  raised. It is never presented as words the User said. Put enough in `context`
  to tell two of your own controls apart.

A surface may carry at most **32** actions.

## The kernel's namespaces

| Name                         | What the kernel does                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval/<approvalId>`      | Records the decision on an Approval **that already exists**, once and durably, ending the Turn that asked for it. An id the kernel never issued is refused on the press. Do not write these by hand — compose `ApprovalActions` and let the host mint them. |
| `plugin/<pluginId>/<action>` | Runs that Plugin's own handler with your authority for the Turn. It answers with messages that update the card, so the press costs no Turn. A handler that fails leaves the card as it was and says so.                                                     |
| anything else                | Conversation input for your next Turn.                                                                                                                                                                                                                      |

## Sending the whole form with a press

Set `"sendDataModel": true` on `createSurface` and the surface's data model
travels with every press, so a form's fields reach you without a binding per
field. Leave it off when the card only raises a choice: the smaller the press,
the less there is to get wrong.

## Components

### `Button`

| Property  | Type                                                    | Required | Binding                        | What it is                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------- | -------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `child`   | ComponentId                                             | yes      | another component's `id`       | The ID of the child component. Use a 'Text' component for a labeled button. Only use an 'Icon' if the requirements explicitly ask for an icon-only button.                                                                                                                             |
| `variant` | `default` \| `primary` \| `borderless`                  | no       | literal                        | A hint for the button style. If omitted, a default button style is used. 'primary' indicates this is the main call-to-action button. 'borderless' means the button has no visual border or background, making its child content appear like a clickable link. Defaults to `"default"`. |
| `action`  | Action                                                  | yes      | `{ event: { name, context } }` |                                                                                                                                                                                                                                                                                        |
| `weight`  | integer                                                 | no       | literal                        | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                                                                                                                                                                                                 |
| `checks`  | array of { condition: DynamicBoolean, message: string } | no       | conditions bindable            | Client-side validation. Each condition is a boolean function call; the message shows when it is false.                                                                                                                                                                                 |

```json
{
  "id": "root",
  "component": "Button",
  "child": "…child…",
  "action": {
    "event": {
      "name": "confirm"
    }
  }
}
```

## Client-side functions

`openUrl` is an action that does not reach you at all — the host opens the link
through its own link handling. Use it for "Open in …", never as a way to make
something happen.

`and`, `or` and `not` compose the boolean checks in `forms.md`.

### `openUrl`

Opens the specified URL in a browser or handler. This function has no return value. Returns `void`.

| Argument | Type   | Required | What it is       |
| -------- | ------ | -------- | ---------------- |
| `url`    | string | yes      | The URL to open. |

```json
{
  "call": "openUrl",
  "args": {
    "url": "…url…"
  }
}
```

### `and`

Performs a logical AND operation on a list of boolean values. Returns `boolean`.

| Argument | Type                    | Required | What it is                              |
| -------- | ----------------------- | -------- | --------------------------------------- |
| `values` | array of DynamicBoolean | yes      | The list of boolean values to evaluate. |

```json
{
  "call": "and",
  "args": {
    "values": [false]
  }
}
```

### `or`

Performs a logical OR operation on a list of boolean values. Returns `boolean`.

| Argument | Type                    | Required | What it is                              |
| -------- | ----------------------- | -------- | --------------------------------------- |
| `values` | array of DynamicBoolean | yes      | The list of boolean values to evaluate. |

```json
{
  "call": "or",
  "args": {
    "values": [false]
  }
}
```

### `not`

Performs a logical NOT operation on a boolean value. Returns `boolean`.

| Argument | Type           | Required | What it is                   |
| -------- | -------------- | -------- | ---------------------------- |
| `value`  | DynamicBoolean | yes      | The boolean value to negate. |

```json
{
  "call": "not",
  "args": {
    "value": false
  }
}
```
