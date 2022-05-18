#!/usr/bin/env sh

set -x

deno run \
    --allow-net=ziglang.org \
    --allow-run=tar,unzip,zig \
    --allow-env=HOME,USERPROFILE,PATH \
    --allow-read \
    --allow-write \
    update-zig.ts \
    "${@}"
