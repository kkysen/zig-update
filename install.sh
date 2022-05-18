#!/usr/bin/env sh

set -x

deno install \
    --allow-net=ziglang.org \
    --allow-run=tar,unzip,zig \
    --allow-env=HOME,USERPROFILE,PATH \
    --allow-read \
    --allow-write \
    "${@}" \
    https://raw.githubusercontent.com/kkysen/zig-update/main/update-zig.ts
