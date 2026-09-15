# Checked-in validation evidence

These two JSON files are deliberately limited to aggregate, synthetic-run metadata. They contain no screenshot, DOM, form value, API key, hostname, model prompt, or raw request body. They are checked in so reviewers can see the baseline that the validation report describes.

The values are historical observations from the development machine, not a guarantee for every browser or GPU. Re-run `Test-Prototype.ps1` and the demo after cloning, record hardware/browser/model details, and attach new evidence for a release or SIH submission. The full generated screenshots, packages, browser profiles, logs, and request captures remain in the ignored local `artifacts/` and `.runtime/` directories.
