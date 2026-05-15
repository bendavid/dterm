__dterm_user_zdotdir=${DTERM_USER_ZDOTDIR:-$HOME}
[ -r "$__dterm_user_zdotdir/.zlogin" ] && . "$__dterm_user_zdotdir/.zlogin"
unset __dterm_user_zdotdir
