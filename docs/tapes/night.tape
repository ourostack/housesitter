# The rehearsed bad night on ouroboros.bot/housesitter and in the README. Made in CI by .github/workflows/media.yml
# (charmbracelet/vhs), never by hand. Everything in it is a fake: a pretend Mac and KVM, run by the same rules.
Output docs/img/night.gif

Set Shell "bash"
Set FontSize 17
Set Width 1280
Set Height 840
Set Padding 26
Set Theme "TokyoNight"
Set TypingSpeed 45ms
Set WindowBar Colorful

Hide
Type `alias housesitter="node $PWD/bin/housesitter.mjs"; clear` Enter
Type "housesitter demo night" Enter
Sleep 2s
Show
# The first frame is the night's end, so a paused GIF still shows it; then the night itself.
Sleep 3s
Hide
Type "clear" Enter
Sleep 300ms
Show

Sleep 500ms
Type "housesitter demo night" Sleep 400ms Enter
Sleep 9s
