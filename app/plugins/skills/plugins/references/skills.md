# Skills this Plugin ships

A Plugin can bundle recipes the Bot loads the same way it loads a managed
Skill. They are offered only while this Plugin is on for this Bot, as
`plugin/<pluginId>/<slug>`. They are not Workspace files: `skill_write`
with `scope: "plugin"` is refused, the way `managed` is.

Put them in `plugin.json` under `skills` — still the same two source
files. At most 8 Skills, 32 references each, 64 KiB per file, and 256 KiB
of Skill text across the Plugin. A malformed document is a recorded
refusal on the Turn that loaded it, not a failed Composition.

```json
"skills": [
  {
    "slug": "draft-reply",
    "text": "---\nname: Draft a reply\ndescription: Use this when you are writing a reply this Plugin will send.\n---\n\n# Draft a reply\n\nCall this Plugin's card tool with the draft, then wait for the decision.\n\n## References\n\n- `tone.md` — how short to keep it.\n",
    "references": [
      { "path": "tone.md", "text": "# Tone\n\nOne or two lines. No sign-off.\n" }
    ]
  }
]
```

- `slug` is the last segment of the catalog ref.
- `text` is a full `SKILL.md`: front matter with `name` and a description
  that starts `Use this when` or `Use this whenever`, then the body. Index
  every reference with a backtick file name.
- `references` (optional): `{ "path", "text" }`. `path` is one `.md` file
  name. The Bot loads one with `skill_load` —
  `{"path": "plugin/<pluginId>/<slug>", "reference": "tone.md"}`.
- Only names, refs, paths and descriptions appear in `<agent_skills>`.
  The body is injected when the User (or you) invokes the Skill, or when
  the Bot calls `skill_load`.

Do not put a secret in a Skill. Do not teach a tool this product does not
offer. The catalog for a Bot that does not run this Plugin will not list
these Skills at all.
