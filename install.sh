#!/usr/bin/env sh

set -x

URL=https://raw.githubusercontent.com/kkysen/zig-update/main/update-zig.ts

deno install \
    --reload="${URL}" \
    --force \
    --allow-net=ziglang.org \
    --allow-run=tar,unzip,zig \
    --allow-env=HOME,USERPROFILE,PATH \
    --allow-read \
    --allow-write \
    "${@}" \
    "${URL}"
