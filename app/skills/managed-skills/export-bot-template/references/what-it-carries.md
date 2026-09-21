# What a template carries

The pack is a recipe, not a clone.

It carries:

- this Bot's name, title and description
- Skills under this Bot's own instruction root
- Routines' prompts (not their run history)
- Catalog Packages the User has installed
- public MCP server addresses

It never carries:

- Memory
- credentials, Connection ids, API keys, OAuth tokens
- the model this Bot is bound to
- webhook signing keys
- uploaded images
- anything from the Computer

Name the _kind_ of Connection a Package needs if the User asks what an
import would still be missing. Do not name a Connection id.
