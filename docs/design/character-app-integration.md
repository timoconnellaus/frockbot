# Character integration into the Flutter app

Status: implemented locally for review, 16 September 2026. The eleven approved
characters now use the production Flutter surfaces and cloud appearance
contract. Release, device profiling and visual sign-off remain outstanding.

## Outcome

Every Bot has a chosen character and colour, consistent across devices and
screens. Its avatar responds to real activity, with restrained ambient movement.
The same component works on Flutter web, Android and macOS. Characters retain
their own anatomy and motion while exposing a common application interface.

Source assets: [cast studio](../../output/flock-rive-animation/README.md) and
[Pixel](../../output/pixel-rive-animation/README.md). The eleven `.riv` files total
approximately 0.4 MB before adding the Rive runtime. Existing validation covers native
Rive rendering and web studio playback; Flutter compatibility and performance
still need to be established.

## What exists in the app

- `apps/native/lib/flock/avatar.dart`: the shared Rive `CharacterAvatar`, full
  cast catalogue, colour binding, activity/emotion inputs, reduced motion,
  still-image fallback and independent quiet-twitch timing. Gaze is fed by the
  surface that owns the pointer rather than read off the character's own
  square: `gaze` carries where to look, `hold` keeps the artboard from drawing
  while a nearby text field is being attached.
- `apps/native/lib/flock/create.dart`: creation and editing for all eleven
  characters plus curated colours.
- The persisted `AvatarAppearanceV1` contains `characterId` and `primary`.
  Registration, templates, Bot-created Bots and identity updates share it.
- Product surfaces include sidebar rows and groups, the conversation companion
  in the header overlay, settings, search, recovery and sign-in. The header
  draws the character cropped to ink over a fade, with frosted name, Computer
  and panel pills on the right, and the thread has no working row: the
  companion is the working indicator and wears the typing badge.
- Realtime voice sends `asked`, `answering` and `finished` delegation events.
  The consulted Bot rises into the voice footer, changes activity while its
  answer is read, then settles away.
- Retired wardrobe assets and routes are removed. A receipt-based pre-user
  cleanup preserves Bot registrations and conversations while replacing the
  incompatible layered appearance with Pixel and deleting stale receipts.

## Surface behaviour

| Surface         | Motion                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot list        | Mostly still; independently timed twitch every 7–18 seconds                                                                                           |
| Bot row hover   | The whole row triggers one restrained hello on desktop/web                                                                                            |
| Chat header     | A quiet live artboard at rest, cropped to ink; the working pose and typing badge while a Turn runs. Existing Rive motion, not a bounce. |
| Mobile chat     | Same activity without pointer tracking; sits at the top of the thread under the status bar                                            |
| Chat gaze       | The eyes follow the pointer anywhere over the conversation pane, held still for 900 ms after a pointer down so the composer keeps its first keystroke |
| Picker/settings | Animated preview of character and selected colour                                                                                                     |
| Voice footer    | The delegated Bot by its character alone: rise/fade/scale handoff, thinking while asked, content while answering, success on finish                   |

All motion yields to `MediaQuery.disableAnimationsOf`, `TickerMode` and the
character's still mode. Widget tests use the checked-in neutral PNG because
Flutter's test renderer cannot host the Rive Native renderer; device and browser
validation exercise the real `.riv` files.

- `apps/native/lib/shell/transcript_model.dart`: turn status, pending state,
  running tools, deliveries and errors. `run_view.dart` already maps live work
  into a visual trail. Sidebar summaries expose less detail than an open chat.
- `apps/native/lib/shell/send_payload.dart`: pending approval records can supply
  an explicit needs-attention cue.
- `apps/native/README.md`: one Flutter client serves web, Android and macOS;
  Flutter 3.47.0 / Dart 3.13.0 must remain pinned.

## The original delivery plan

Everything below is the plan as it was written before the work, kept as the
record of what was intended and why. It is not a description of the app today:
where it disagrees with **What exists in the app** and **Surface behaviour**
above, those sections are authoritative. In particular the working ring and
trail, and the conversation header's avatar, were reviewed and removed.

### 1. Prove the renderer in a Flutter studio

Build a development-only Flutter studio using all eleven actual `.riv` assets,
the current behaviour controls and the character switcher. This is the first
review milestone before replacing product avatars.

- Pin a compatible stable official Rive Flutter package after testing it with
  the existing Flutter SDK and CLI-generated assets. Do not upgrade Flutter.
- Start with the Rive renderer. Check colour data binding, state-machine names,
  transparency, gestures and independent instances on all three targets.
- Create one `CharacterAvatar` widget. Callers pass appearance, activity,
  expression, size and interaction policy; Rive property names remain internal.
- Cache decoded files per character. Give every displayed instance its own
  controller and view model so one Bot's colour or gaze cannot affect another.
- Bundle files locally. Keep a neutral image per character for load failure;
  this fallback can use the original palette. A failed renderer must not remove
  navigation or the Bot's accessible name.
- Inspect actual app sizes (24, 28, 40, 76, 96 and 112 pixels), both themes and
  device scale factors. Define optical framing per character: keep ears and feet
  visible, with enough margin for every gesture and consistent perceived size.

Rive's current Flutter documentation recommends `RiveWidget` with optional
`RiveWidgetBuilder`, supports reusable file loaders, and offers `RivePanel` for
multiple widgets sharing a render texture. Use shared rendering where profiling
shows it helps, particularly web lists; preserve per-instance state.
[Official Flutter runtime documentation](https://rive.app/docs/runtimes/flutter/flutter).

Acceptance: the studio works on Flutter web, Android and macOS; two instances of
the same character can have different colours and expressions; loading, removal,
resize and repeated switching do not leak controllers or show stale characters.

### 2. Save appearance and offer a character picker

Proposed stored appearance: `characterId` plus a validated primary colour,
inside the app's normal versioned wire envelope. Use `avatar` as the registration
field and `CharacterAppearance` as the code type. Keep scene names, pivots,
palette derivation and file paths in a build-time catalogue.

The colour picker should match the studio. Derive shade using the character's
original palette when appropriate; keep eyes, outlines and fixed markings at
their approved defaults. Individual eye/shade customization is outside the
first UI. The default backdrop is transparent; surfaces own their background.

- Let users choose any character independently of the Bot's job or personality.
- Offer the eleven thumbnails, original colour, curated swatches, custom colour
  and a randomize action with an immediate animated preview.
- Use the same picker for creating a Bot and editing its avatar in settings.
- Preserve existing revision/conflict handling for edits. Commit appearance to
  the cloud, then show the acknowledged choice consistently on other devices.
- Choose a deterministic default from the catalogue when no choice is supplied
  at creation; persist it once. A Bot must not change appearance on refresh.

Replace the old clothing recipe, endpoint/command names, validation and generated
wire bindings coherently. Include Bot-created Bots and template import/export,
not just the user creation sheet. Remove the obsolete wardrobe paths and assets
once all callers use the new appearance model.

This changes persisted data. Follow the repository's disposable-test-data rule:
prepare a scoped, repeatable cleanup of incompatible avatar-bearing test records
and cached/pending commands. Inventory affected directory, identity, command and
template records before release. Execute and verify cleanup as part of that
release; do not retain a legacy decoder or reset unrelated conversations. Nothing
is cleaned up during this planning step.

Acceptance: create, edit, reload, reconnect and second-device reads preserve the
same character/colour; conflict and failure paths are visible and recoverable;
fresh Bot creation and conversation work after the coordinated data change.

### 3. Connect actual activity to motion

Keep saved identity separate from temporary animation state. A small deterministic
presentation function maps existing server projections into activity and feeling.
The backend remains authoritative about work; animation is a client projection.

| Observed condition                            | Avatar response                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| No active work                                | Neutral idle with occasional blink and species gesture                      |
| Turn admitted but queued                      | Quiet neutral waiting; retain the existing queued label                     |
| Active turn with no running tool              | Thinking; this is a waiting/processing cue, not a claim to detect reasoning |
| Running tool or visible output delivery       | Working                                                                     |
| Explicit unresolved approval / required input | Needs you, with a curious/uncertain expression                              |
| Newly completed successful turn               | One restrained success gesture, then idle                                   |
| Failed turn                                   | Brief uncertain expression; preserve the actionable error text              |
| User stopped or superseded the turn           | Return to neutral without celebrating                                       |
| Connection unavailable                        | Keep the connection status visible; do not infer sadness or success         |

Where a surface has only a `working` summary, use generic working rather than
inventing a detailed phase or making extra per-avatar network requests. Use
needs-input only when the application has an explicit signal; silence alone
does not mean the user must act.

Precedence: reduced motion controls movement first; attention/failure cues take
priority over ordinary work; a new turn cancels a previous celebration. Hover
and gaze remain subtle additive reactions. A short settling delay prevents
rapid thinking/working flicker between adjacent events.

Success is keyed to a newly observed terminal turn transition. Loading history,
reconnecting and rebuilding widgets must not replay it. Cancel timers on Bot
switch, new work and disposal. The studio's temporary 2.6-second success override
must become an owned, tested Flutter behaviour rather than an untracked timer.

Keep sad, tired, excited and the other expressions available in the studio and
component API. Do not assign them to production events without a clear meaning;
network failures should not make the character perform distress. Add listening
or speaking behaviour only when we explicitly design that voice interaction.

### 4. Replace avatar surfaces and tune interaction

Use `CharacterAvatar` everywhere, passing the same appearance. Review sidebar,
groups, conversation header, working indicator, create/edit sheets, settings,
search, recovery and sign-in. The account user avatar remains separate.

For the first pass:

- Animate the current Bot and visible active Bot rows. Quiet list entries use a
  restrained idle or still pose; historical transcript avatars stay still.
- Larger picker/profile previews get richer movement. Gaze follows the nearby
  pointer on desktop/web only when that surface enables it.
- A pointer entering a character may trigger one greeting. On touch, selecting
  a character can trigger that greeting without adding a competing tap target
  to navigation rows. Do not simulate a missing mouse on mobile.
- Pause when the app is backgrounded, a route is covered or the item is offscreen.
  Honour the existing `MediaQuery.disableAnimationsOf` policy. Render a stable
  neutral pose when motion is disabled; keep textual status cues available.
- Keep the existing working ring/trail through the first in-app review, then
  decide whether each is redundant at real sizes. Avoid changing both status
  legibility and its visual treatment without reviewing them together.
- Avoid synchronized idle gestures across the whole sidebar; test controlled
  phase offsets for ambient motion without shifting event-driven reactions.

Acceptance: scrolling a busy sidebar stays smooth; hidden instances stop
advancing; selection, keyboard navigation and screen-reader labels still work;
animation never becomes the sole indicator of work, errors or required input.

### 5. Validate and deliver

Test the pure status mapping, one-shot lifecycle, identity validation and cloud
round trips. Widget tests should exercise loading/failure handling, switching,
independent instances and reduced motion. Use real renderer/device tests for
appearance and performance; a mocked widget cannot establish those properties.

Profile a realistic multi-Bot sidebar and a stress fixture on web, Android and
macOS. Check memory after repeated navigation, first-load cost, background CPU,
frame times and small-size visual quality. Run the repository's required full
validation for client/integration changes and the browser suite before merge.

The first shipment adds native runtime code and bundled assets: deliver a full
Android APK through the established Shorebird release workflow, not a Dart-only
patch. Update the macOS app using the prescribed desktop updater. Ship the web
build and coordinated server contract/cleanup together, with the native minimum
version updated if required to exclude clients speaking the removed schema.
Normal release approval remains the final deployment gate.

### Suggested checkpoints

1. **Flutter studio:** all eleven characters, colours and behaviours on the real
   app platforms; settle framing and renderer performance.
2. **One complete Bot:** choose character/colour, save it, see it consistently in
   the app, and drive it from a real turn and approval.
3. **Whole app:** remaining surfaces, accessibility/performance checks, legacy
   removal and coordinated release.

Recommendation: start with checkpoint 1. The remaining product choices can be
reviewed in context rather than decided from the browser prototype alone.
