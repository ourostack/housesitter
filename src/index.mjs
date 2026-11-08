// @ouro.bot/housesitter: the library under the CLI.
export { open, driver, registerTransport, directTransport, outboxTransport, Refusal } from './hands.mjs';
export * as watchdog from './watchdog.mjs';
export { classifyScreen } from './screen.mjs';
export { keyNames, absPoint, looksSecret, imageSize } from './keys.mjs';
export { makeClient, connect, httpsRequest, summarise } from './kvmd.mjs';
export { loadConfig, macConfig, secretStore, configPath } from './config.mjs';
export { sitterClient, describeStatus } from './sitter.mjs';
export { fakeWorld } from './fake.mjs';
