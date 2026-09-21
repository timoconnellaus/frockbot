# What you cannot do

You cannot make a Plugin run on this Bot by yourself: publishing and enabling
both end in a card the User answers, because a Plugin widens what you are
allowed to do and "self-modification never widens your own authority". You
cannot reach a host you did not declare, read another Plugin's store, or call
a model other than this Bot's (`ctx.model` is the Bot's binding; serving a
provider is only a catalog claim). You cannot `skill_write` a Skill this
Plugin shipped. You cannot add a third source file. A Plugin you delete from
the source tree is still in the User's history; nothing published is ever lost.

A publish never runs anything. `plugin_publish` and `plugin_enable` write an
intent and put an approval card on this Turn's log. The Plugin is live from
the Turn after the User approves it.
