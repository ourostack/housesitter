// What the Mac's screen is, from the text OCR reads on the KVM's picture. Typing a password is safe only at
// 'filevault' or 'login'; a 'desktop' is a hard no, because the password would land in whatever app has focus.
// device/sitter.py has the same rules (classify_screen); test/parity.test.mjs runs both on the same texts.
//
// Apple Silicon's FileVault screen shows the account picture and name, a password field ("Enter Password"), and
// Restart / Shut Down. The login window looks the same after FileVault is open. A menu bar, or app names, mean a
// logged-in desktop.

const MENU = /\b(Finder|File|Edit|View|Window|Help|Go)\b[\s\S]*\b(File|Edit|View|Window|Help)\b/;
const APPS = /\b(Terminal|Safari|Google Chrome|Microsoft Edge|Firefox|Slack|Mail|Messages|Xcode|Visual Studio Code|Ghostty|iTerm|Activity Monitor|System Settings)\b/;

export function classifyScreen(text, { userNames = [] } = {}) {
  if (text == null) return { kind: 'unknown', why: 'no text read' };
  const t = String(text);
  if (!t.trim()) return { kind: 'blank', why: 'no text on the picture (black, asleep, or another display)' };
  if (MENU.test(t) || APPS.test(t)) return { kind: 'desktop', why: 'a menu bar or apps are on screen' };
  const names = userNames.filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const around = new RegExp(`(Restart|Shut Down|Sleep|FileVault|Other|Switch User${names.length ? `|${names.join('|')}` : ''})`, 'i');
  if (/Enter Password|Password/i.test(t) && around.test(t)) {
    return { kind: /FileVault|Disk Password|unlock/i.test(t) ? 'filevault' : 'login', why: 'the password prompt is on screen' };
  }
  if (/Screen Time|Lock Screen|is locked/i.test(t)) return { kind: 'login', why: 'the lock screen is on screen' };
  return { kind: 'unknown', why: `unrecognised: ${t.replace(/\s+/g, ' ').slice(0, 80)}` };
}
