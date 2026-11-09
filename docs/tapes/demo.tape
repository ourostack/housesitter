# The terminal recording in the README and on ouroboros.bot/housesitter. Made in CI by .github/workflows/media.yml
# (charmbracelet/vhs), never by hand: `housesitter demo` replays real frames from our KVM, and `adopt --fake` is the
# rehearsal it says it is.
Output docs/img/demo.gif

Set Shell "bash"
Set FontSize 14
Set Width 1240
Set Height 860
Set Padding 26
Set Theme "TokyoNight"
Set TypingSpeed 40ms
Set WindowBar Colorful

Hide
Type "alias housesitter='node bin/housesitter.mjs'; export HOUSESITTER_CONFIG=$PWD/.vhs-config.json; clear" Enter
Show

Sleep 600ms
Type "housesitter demo" Sleep 500ms Enter
Sleep 13s
Type "clear" Enter
Sleep 300ms
Type "housesitter adopt studio --fake --notify ntfy" Sleep 500ms Enter
Sleep 5s
