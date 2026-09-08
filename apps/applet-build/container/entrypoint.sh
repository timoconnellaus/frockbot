#!/bin/sh
set -eu

# The build stages want the whole box in turn, and the Node default heap is a
# fraction of even the smallest instance. Raised here rather than baked into
# the image's CMD so the ceiling tracks the instance type, which is the thing
# that actually changes.
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
export NODE_OPTIONS

exec npm start
