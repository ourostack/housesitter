# Hotfix for @ouro.bot/cli dist/repertoire/vault-unlock.js until upstream ships: an explicit machine-level choice of
# unlock store, OURO_VAULT_UNLOCK_STORE (e.g. plaintext-file on a headless Linux appliance with no Secret Service).
import shutil, sys
f = sys.argv[1]
s = open(f).read()
needle = "function resolveVaultUnlockStore(config, deps = {}) {\n    const canonicalConfig = canonicalizeVaultUnlockConfig(config);\n    const requested = validateStoreKind(deps.store);"
assert s.count(needle) == 1, "pattern not found"
shutil.copy(f, f + ".orig")
s = s.replace(needle, needle.replace("validateStoreKind(deps.store)", "validateStoreKind(deps.store ?? (process.env.OURO_VAULT_UNLOCK_STORE || undefined))"))
open(f, "w").write(s)
print("patched", f)
