# Text and media

_A reference of `managed/a2ui`. The tables below are generated from the
catalogs the app draws; do not edit them by hand._

## When to use

`Text` carries nearly everything a card says. Give the card's title `"variant":
"h3"` or `"h4"` and leave the rest at the default body style; a card is not a
document, and a stack of headings reads as one.

Simple Markdown works inside `Text` — emphasis, a bullet list — but no HTML, no
images and no links. A link is a `Button` with an `openUrl` action (see
`actions.md`), and an image is an `Image`.

For a long body — a draft, a quote, anything that would push the controls off
the screen — use `CollapsibleText` from `frock.md` instead of a `Text`.

**Media is https only.** A `url` that is not `https://` refuses the whole
surface. Only link to something you were actually given a URL for; do not
invent one, and do not embed a video or an audio player unless the User asked
for that thing.

`Icon` takes a name from a fixed set, so check the table before using one. An
icon on its own says very little — pair it with a `Text` in a `Row`, or skip
it.

## Components

### `Text`

| Property  | Type                                                        | Required | Binding  | What it is                                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`    | DynamicString                                               | yes      | bindable | The text content to display. While simple Markdown formatting is supported (i.e. without HTML, images, or links), utilizing dedicated UI components is generally preferred for a richer and more structured presentation. |
| `variant` | `h1` \| `h2` \| `h3` \| `h4` \| `h5` \| `caption` \| `body` | no       | literal  | A hint for the base text style. Defaults to `"body"`.                                                                                                                                                                     |
| `weight`  | integer                                                     | no       | literal  | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                                                                                                                                    |

```json
{
  "id": "root",
  "component": "Text",
  "text": "…text…"
}
```

### `Image`

| Property      | Type                                                                                  | Required | Binding  | What it is                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `url`         | DynamicString                                                                         | yes      | bindable | The URL of the image to display.                                                                                                         |
| `description` | DynamicString                                                                         | no       | bindable | Accessibility text for the image.                                                                                                        |
| `fit`         | `contain` \| `cover` \| `fill` \| `none` \| `scaleDown`                               | no       | literal  | Specifies how the image should be resized to fit its container. This corresponds to the CSS 'object-fit' property. Defaults to `"fill"`. |
| `variant`     | `icon` \| `avatar` \| `smallFeature` \| `mediumFeature` \| `largeFeature` \| `header` | no       | literal  | A hint for the image size and style. Defaults to `"mediumFeature"`.                                                                      |
| `weight`      | integer                                                                               | no       | literal  | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one.                                                   |

```json
{
  "id": "root",
  "component": "Image",
  "url": "…url…"
}
```

### `Icon`

| Property | Type                                                        | Required | Binding | What it is                                                                             |
| -------- | ----------------------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `name`   | string (listed below) \| { svgPath: string } \| DataBinding | yes      | literal | The name of the icon to display.                                                       |
| `weight` | integer                                                     | no       | literal | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one. |

`name` is one of: `accountCircle`, `add`, `arrowBack`, `arrowForward`, `attachFile`, `calendarToday`, `call`, `camera`, `check`, `close`, `delete`, `download`, `edit`, `event`, `error`, `fastForward`, `favorite`, `favoriteOff`, `folder`, `help`, `home`, `info`, `locationOn`, `lock`, `lockOpen`, `mail`, `menu`, `moreVert`, `moreHoriz`, `notificationsOff`, `notifications`, `pause`, `payment`, `person`, `phone`, `photo`, `play`, `print`, `refresh`, `rewind`, `search`, `send`, `settings`, `share`, `shoppingCart`, `skipNext`, `skipPrevious`, `star`, `starHalf`, `starOff`, `stop`, `upload`, `visibility`, `visibilityOff`, `volumeDown`, `volumeMute`, `volumeOff`, `volumeUp`, `warning`.

```json
{
  "id": "root",
  "component": "Icon",
  "name": "accountCircle"
}
```

### `Video`

| Property | Type          | Required | Binding  | What it is                                                                             |
| -------- | ------------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `url`    | DynamicString | yes      | bindable | The URL of the video to display.                                                       |
| `weight` | integer       | no       | literal  | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one. |

```json
{
  "id": "root",
  "component": "Video",
  "url": "…url…"
}
```

### `AudioPlayer`

| Property      | Type          | Required | Binding  | What it is                                                                             |
| ------------- | ------------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `url`         | DynamicString | yes      | bindable | The URL of the audio to be played.                                                     |
| `description` | DynamicString | no       | bindable | A description of the audio, such as a title or summary.                                |
| `weight`      | integer       | no       | literal  | Its share of a `Row` or `Column`, like CSS `flex-grow`. Only on a direct child of one. |

```json
{
  "id": "root",
  "component": "AudioPlayer",
  "url": "…url…"
}
```
