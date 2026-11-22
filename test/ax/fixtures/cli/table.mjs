// A command table shaped like src/cli-table.mjs.
const cmd = (def) => defineCommand(def);
const COMMANDS = [
  cmd({ name: 'status', summary: 'whether the KVM answers', effect: 'private', readOnly: true }),
  cmd({ name: 'unlock', summary: 'ask the sitter to unlock the Mac', effect: 'others' }),
  defineCommand({ name: 'peer send', summary: 'send a message', effect: 'others' }),
  other({ name: 'not-a-command' }),
  cmd({ name: computed, summary: 'a name that is not a literal' }),
];
