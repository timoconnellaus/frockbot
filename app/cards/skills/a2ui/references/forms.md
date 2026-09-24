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
into a web page without ever seeing the value (`frock.md`, `SecretField`).

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

### `TextField`

| Property           | Type                                                    | Required | Binding             | What it is                                                                                             |
| ------------------ | ------------------------------------------------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `label`            | DynamicString                                           | yes      | bindable            | The text label for the input field.                                                                    |
| `value`            | DynamicString                                           | no       | bindable            | The value of the text field.                                                                           |
| `variant`          | `longText` \| `number` \| `shortText` \| `obscured`     | no       | literal             | The type of input field to display. Defaults to `"shortText"`.                                         |
| `validationRegexp` | string                                                  | no       | literal             | A regular expression used for client-side validation of the input.                                     |
| `weight`           | integer                                                 | no       | literal             | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                 |
| `checks`           | array of { condition: DynamicBoolean, message: string } | no       | conditions bindable | Client-side validation. Each condition is a boolean function call; the message shows when it is false. |

```json
{
  "id": "root",
  "component": "TextField",
  "label": "…label…"
}
```

### `CheckBox`

| Property | Type                                                    | Required | Binding             | What it is                                                                                             |
| -------- | ------------------------------------------------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `label`  | DynamicString                                           | yes      | bindable            | The text to display next to the checkbox.                                                              |
| `value`  | DynamicBoolean                                          | yes      | bindable            | The current state of the checkbox (true for checked, false for unchecked).                             |
| `weight` | integer                                                 | no       | literal             | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                 |
| `checks` | array of { condition: DynamicBoolean, message: string } | no       | conditions bindable | Client-side validation. Each condition is a boolean function call; the message shows when it is false. |

```json
{
  "id": "root",
  "component": "CheckBox",
  "label": "…label…",
  "value": false
}
```

### `DateTimeInput`

| Property     | Type                                                    | Required | Binding             | What it is                                                                                               |
| ------------ | ------------------------------------------------------- | -------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `value`      | DynamicString                                           | yes      | bindable            | The selected date and/or time value in ISO 8601 format. If not yet set, initialize with an empty string. |
| `enableDate` | boolean                                                 | no       | literal             | If true, allows the user to select a date. Defaults to `false`.                                          |
| `enableTime` | boolean                                                 | no       | literal             | If true, allows the user to select a time. Defaults to `false`.                                          |
| `min`        | DynamicString                                           | no       | bindable            | The minimum allowed date/time in ISO 8601 format.                                                        |
| `max`        | DynamicString                                           | no       | bindable            | The maximum allowed date/time in ISO 8601 format.                                                        |
| `label`      | DynamicString                                           | no       | bindable            | The text label for the input field.                                                                      |
| `weight`     | integer                                                 | no       | literal             | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                   |
| `checks`     | array of { condition: DynamicBoolean, message: string } | no       | conditions bindable | Client-side validation. Each condition is a boolean function call; the message shows when it is false.   |

```json
{
  "id": "root",
  "component": "DateTimeInput",
  "value": "…value…"
}
```

### `ChoicePicker`

A component that allows selecting one or more options from a list.

| Property       | Type                                                    | Required | Binding                       | What it is                                                                                             |
| -------------- | ------------------------------------------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `label`        | DynamicString                                           | no       | bindable                      | The label for the group of options.                                                                    |
| `variant`      | `multipleSelection` \| `mutuallyExclusive`              | no       | literal                       | A hint for how the choice picker should be displayed and behave. Defaults to `"mutuallyExclusive"`.    |
| `options`      | array of { label: DynamicString, value: string }        | yes      | literal rows; values bindable | The list of available options to choose from.                                                          |
| `value`        | DynamicStringList                                       | yes      | bindable                      | The list of currently selected values. This should be bound to a string array in the data model.       |
| `displayStyle` | `checkbox` \| `chips`                                   | no       | literal                       | The display style of the component. Defaults to `"checkbox"`.                                          |
| `filterable`   | boolean                                                 | no       | literal                       | If true, displays a search input to filter the options. Defaults to `false`.                           |
| `weight`       | integer                                                 | no       | literal                       | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                 |
| `checks`       | array of { condition: DynamicBoolean, message: string } | no       | conditions bindable           | Client-side validation. Each condition is a boolean function call; the message shows when it is false. |

```json
{
  "id": "root",
  "component": "ChoicePicker",
  "options": [
    {
      "label": "…label…",
      "value": "…value…"
    }
  ],
  "value": []
}
```

### `Slider`

| Property | Type                                                    | Required | Binding             | What it is                                                                                             |
| -------- | ------------------------------------------------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `label`  | DynamicString                                           | no       | bindable            | The label for the slider.                                                                              |
| `min`    | number                                                  | no       | literal             | The minimum value of the slider. Defaults to `0`.                                                      |
| `max`    | number                                                  | yes      | literal             | The maximum value of the slider.                                                                       |
| `value`  | DynamicNumber                                           | yes      | bindable            | The current value of the slider.                                                                       |
| `weight` | integer                                                 | no       | literal             | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                 |
| `checks` | array of { condition: DynamicBoolean, message: string } | no       | conditions bindable | Client-side validation. Each condition is a boolean function call; the message shows when it is false. |

```json
{
  "id": "root",
  "component": "Slider",
  "max": 1,
  "value": 0
}
```

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

### `required`

Checks that the value is not null, undefined, or empty. Returns `boolean`.

| Argument | Type | Required | What it is          |
| -------- | ---- | -------- | ------------------- |
| `value`  | any  | yes      | The value to check. |

```json
{
  "call": "required",
  "args": {
    "value": "…value…"
  }
}
```

### `regex`

Checks that the value matches a regular expression string. Returns `boolean`.

| Argument  | Type          | Required | What it is                          |
| --------- | ------------- | -------- | ----------------------------------- |
| `value`   | DynamicString | yes      |                                     |
| `pattern` | string        | yes      | The regex pattern to match against. |

```json
{
  "call": "regex",
  "args": {
    "value": "…value…",
    "pattern": "…pattern…"
  }
}
```

### `length`

Checks string length constraints. Returns `boolean`.

| Argument | Type          | Required | What it is                  |
| -------- | ------------- | -------- | --------------------------- |
| `value`  | DynamicString | yes      |                             |
| `min`    | integer       | no       | The minimum allowed length. |
| `max`    | integer       | no       | The maximum allowed length. |

```json
{
  "call": "length",
  "args": {
    "value": "…value…"
  }
}
```

### `numeric`

Checks numeric range constraints. Returns `boolean`.

| Argument | Type          | Required | What it is                 |
| -------- | ------------- | -------- | -------------------------- |
| `value`  | DynamicNumber | yes      |                            |
| `min`    | number        | no       | The minimum allowed value. |
| `max`    | number        | no       | The maximum allowed value. |

```json
{
  "call": "numeric",
  "args": {
    "value": 0
  }
}
```

### `email`

Checks that the value is a valid email address. Returns `boolean`.

| Argument | Type          | Required | What it is |
| -------- | ------------- | -------- | ---------- |
| `value`  | DynamicString | yes      |            |

```json
{
  "call": "email",
  "args": {
    "value": "…value…"
  }
}
```

### `formatString`

Performs string interpolation of data model values and other functions in the catalog functions list and returns the resulting string. The value string can contain interpolated expressions in the `${expression}` format. Supported expression types include: JSON Pointer paths to the data model (e.g., `${/absolute/path}` or `${relative/path}`), and client-side function calls (e.g., `${now()}`). Function arguments must be named (e.g., `${formatDate(value:${/currentDate}, format:'MM-dd')}`). To include a literal `${` sequence, escape it as `\${`. Returns `string`.

| Argument | Type          | Required | What it is |
| -------- | ------------- | -------- | ---------- |
| `value`  | DynamicString | yes      |            |

```json
{
  "call": "formatString",
  "args": {
    "value": "…value…"
  }
}
```

### `formatNumber`

Formats a number with the specified grouping and decimal precision. Returns `string`.

| Argument   | Type           | Required | What it is                                                                                                                                |
| ---------- | -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `value`    | DynamicNumber  | yes      | The number to format.                                                                                                                     |
| `decimals` | DynamicNumber  | no       | Optional. The number of decimal places to show. Defaults to 0 or 2 depending on locale.                                                   |
| `grouping` | DynamicBoolean | no       | Optional. If true, uses locale-specific grouping separators (e.g. '1,000'). If false, returns raw digits (e.g. '1000'). Defaults to true. |

```json
{
  "call": "formatNumber",
  "args": {
    "value": 0
  }
}
```

### `formatCurrency`

Formats a number as a currency string. Returns `string`.

| Argument   | Type           | Required | What it is                                                                                                                                |
| ---------- | -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `value`    | DynamicNumber  | yes      | The monetary amount.                                                                                                                      |
| `currency` | DynamicString  | yes      | The ISO 4217 currency code (e.g., 'USD', 'EUR').                                                                                          |
| `decimals` | DynamicNumber  | no       | Optional. The number of decimal places to show. Defaults to 0 or 2 depending on locale.                                                   |
| `grouping` | DynamicBoolean | no       | Optional. If true, uses locale-specific grouping separators (e.g. '1,000'). If false, returns raw digits (e.g. '1000'). Defaults to true. |

```json
{
  "call": "formatCurrency",
  "args": {
    "value": 0,
    "currency": "…currency…"
  }
}
```

### `formatDate`

Formats a timestamp into a string using a pattern. Returns `string`.

| Argument | Type          | Required | What it is                                                                                                                                                                                                                                                         |
| -------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `value`  | DynamicValue  | yes      | The date to format.                                                                                                                                                                                                                                                |
| `format` | DynamicString | yes      | A Unicode TR35 date pattern string. Token Reference: - Year: 'yy' (26), 'yyyy' (2026) - Month: 'M' (1), 'MM' (01), 'MMM' (Jan), 'MMMM' (January) - Day: 'd' (1), 'dd' (01), 'E' (Tue), 'EEEE' (Tuesday) - Hour (12h): 'h' (1-12), 'hh' (01-12) - requires 'a' for… |

```json
{
  "call": "formatDate",
  "args": {
    "value": "…value…",
    "format": "…format…"
  }
}
```

### `pluralize`

Returns a localized string based on the Common Locale Data Repository (CLDR) plural category of the count (zero, one, two, few, many, other). Requires an 'other' fallback. For English, just use 'one' and 'other'. Returns `string`.

| Argument | Type          | Required | What it is                                                                |
| -------- | ------------- | -------- | ------------------------------------------------------------------------- |
| `value`  | DynamicNumber | yes      | The numeric value used to determine the plural category.                  |
| `zero`   | DynamicString | no       | String for the 'zero' category (e.g., 0 items).                           |
| `one`    | DynamicString | no       | String for the 'one' category (e.g., 1 item).                             |
| `two`    | DynamicString | no       | String for the 'two' category (used in Arabic, Welsh, etc.).              |
| `few`    | DynamicString | no       | String for the 'few' category (e.g., small groups in Slavic languages).   |
| `many`   | DynamicString | no       | String for the 'many' category (e.g., large groups in various languages). |
| `other`  | DynamicString | yes      | The default/fallback string (used for general plural cases).              |

```json
{
  "call": "pluralize",
  "args": {
    "value": 0,
    "other": "…other…"
  }
}
```
