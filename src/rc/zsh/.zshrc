__dterm_user_zdotdir=${DTERM_USER_ZDOTDIR:-$HOME}
[ -r "$__dterm_user_zdotdir/.zshrc" ] && . "$__dterm_user_zdotdir/.zshrc"
unset __dterm_user_zdotdir
# dterm: install SIGUSR1 hook for env refresh on reattach.
trap '[ -n "$DTERM_ENV_FILE" ] && [ -r "$DTERM_ENV_FILE" ] && . "$DTERM_ENV_FILE"' USR1
