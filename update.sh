#!/usr/bin/env sh

set -x

deno run --allow-net=ziglang.org --allow-run --allow-read --allow-write update.ts "${@}"
