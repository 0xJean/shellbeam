#!/bin/sh
# Immutable synthetic CLI fixture. Tests never rewrite an executable while
# other native tests may be spawning children and inheriting open descriptors.
case "$1" in
  echo-stdin) cat; printf 'private error' >&2 ;;
  descendants) (sleep 0.6; touch survived) & wait ;;
  malformed) printf 'not json\n'; sleep 10 ;;
  excessive) head -c 1100000 /dev/zero ;;
  --version) echo 'codex-cli 0.160.1' ;;
  exec) echo '--ignore-user-config --ignore-rules --ephemeral --sandbox --json' ;;
  *)
    cat >/dev/null
    printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"uname -a"}}' '{"type":"turn.completed"}'
    ;;
esac
