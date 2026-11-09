# The terminal recording on ouroboros.bot/housesitter and in the README. Made in CI by .github/workflows/media.yml
# (charmbracelet/vhs), never by hand. `housesitter demo` replays real frames from our KVM; `look --picture` reads a
# real frame of our lock screen (docs/tapes/lock-screen.jpg) against the prompt taught from three real frames.
Output docs/img/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1180
Set Height 860
Set Padding 26
Set Theme "TokyoNight"
Set TypingSpeed 45ms
Set WindowBar Colorful

Hide
Type `alias housesitter="node $PWD/bin/housesitter.mjs"; cd docs/tapes; clear` Enter
Show

Sleep 500ms
Type "housesitter demo" Sleep 400ms Enter
Sleep 12s
Type "clear" Enter
Sleep 300ms
Type "housesitter look --picture lock-screen.jpg --home ./mini" Sleep 400ms Enter
Sleep 6s
