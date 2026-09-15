# Security policy

This repository contains a privacy-boundary prototype, not a certified anonymization product. Treat all demo values as synthetic and do not connect it to real personal data until the independent review and production controls listed in `TEAM_HANDOFF.md` are complete.

## Reporting

If you find a way for raw browser content, a secret, or a real hostname to enter the reasoning request, logs, telemetry, model prompt, or generated artifact, report it privately to the repository maintainers. Include:

- a short impact description;
- the affected commit, browser, operating system, and model/runtime versions;
- a minimal synthetic reproduction or test case;
- whether the issue requires a malicious page, extension permission, server compromise, or local access.

Do not include real credentials, personal data, API keys, cookies, browser profiles, or unredacted screenshots in the report. Rotate any secret that may have been exposed before reporting.

## Scope

The prototype's reasoning-channel boundary covers the extension's configured `/v1/reason` endpoint and the server's Ollama request. It does not intercept ordinary website traffic, downloads, cookies used by the visited site, other extensions, another application's screen capture, the operating system, or a compromised browser/runtime. Reports outside that boundary are still useful, but should describe the separate trust assumption.
