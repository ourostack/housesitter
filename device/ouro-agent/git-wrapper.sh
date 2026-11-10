#!/bin/sh
# git for the Comet: Alpine's aarch64 git and its libraries under /userdata/ouro/git, run by musl's loader
# (/lib/ld-musl-aarch64.so.1 -> here; library path in /etc/ld-musl-aarch64.path), so firmware glibc is untouched.
G=/userdata/ouro/git
export GIT_EXEC_PATH=$G/usr/libexec/git-core
export GIT_TEMPLATE_DIR=$G/usr/share/git-core/templates
export GIT_SSL_CAINFO=${GIT_SSL_CAINFO:-/etc/ssl/certs/ca-certificates.crt}
exec $G/usr/bin/git "$@"
