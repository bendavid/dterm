# dterm: bounce to the user's real ZDOTDIR so their normal startup runs.
__dterm_user_zdotdir=${DTERM_USER_ZDOTDIR:-$HOME}
[ -r "$__dterm_user_zdotdir/.zshenv" ] && . "$__dterm_user_zdotdir/.zshenv"
unset __dterm_user_zdotdir
