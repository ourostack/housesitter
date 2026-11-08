#!/usr/bin/env node
// SSH_ASKPASS for `housesitter adopt`: prints the KVM's admin password, read from the secret store by reference, so
// the password never sits in ssh's argv, the environment or a file. Only answers when adopt set the reference.
import { secretStore } from '../src/config.mjs';

const ref = process.env.HOUSESITTER_ASKPASS_REF;
if (!ref || !/password/i.test(process.argv.slice(2).join(' '))) process.exit(1);
const v = secretStore().get(ref);
if (!v) process.exit(1);
process.stdout.write(`${v}\n`);
