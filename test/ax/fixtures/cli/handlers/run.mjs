export function run(word) {
  if (word === 'unlock') throw new Refusal('sitter-refused', 'no');
  const card = { code: 'only-in-a-card', means: 'a card, not a raise', fix: 'none' };
  throw new AxError({ code: 'unknown-command', card });
}
