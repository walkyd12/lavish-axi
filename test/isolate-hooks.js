// Test processes must never inherit live services or executable hooks from the operator's shell.
// Tests may explicitly configure disposable local fixtures after importing this module.
for (const key of Object.keys(process.env)) {
  if (
    /^LAVISH_AXI_(?:ON_|.*HOOK|APPROVAL_PREVIEW$|NOTIFY_DESTINATIONS$|HUB_PEERS$|(?:BUILD_)?UMAMI_|HTML_APP_|HERDR_CHIME$|HOST$|LINK_HOST$|PUBLIC_URL$|PORT$)/.test(
      key,
    )
  )
    delete process.env[key];
}
// Disabling telemetry also covers defaults embedded in a previously built CLI.
process.env.LAVISH_AXI_TELEMETRY = "0";
