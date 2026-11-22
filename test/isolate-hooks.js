// Test processes must never inherit executable hooks from the operator's shell.
// Tests may explicitly install their own disposable hook after importing this module.
for (const key of Object.keys(process.env)) {
  if (/^LAVISH_AXI_(?:ON_|.*HOOK|APPROVAL_PREVIEW$|NOTIFY_DESTINATIONS$)/.test(key)) delete process.env[key];
}
