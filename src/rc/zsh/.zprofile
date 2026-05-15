__dterm_user_zdotdir=${DTERM_USER_ZDOTDIR:-$HOME}
[ -r "$__dterm_user_zdotdir/.zprofile" ] && . "$__dterm_user_zdotdir/.zprofile"
unset __dterm_user_zdotdir
