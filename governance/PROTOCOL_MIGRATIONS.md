# Protocol and policy migration record

The current public contract is protocol `1.0` and policy `1.0`. This record is
the review point for every future schema, detector category, action, permission,
or serialized field change.

## Version 1.0 (current)

- Observation and response schemas are strict and reject unknown fields.
- The only reasoning egress is `extension/src/egress.ts`.
- Allowed actions are `click`, `input`, `scroll`, `wait`, and `done`.
- Privacy grades are cumulative integers 1, 2, and 3; omitted legacy grades fail
  safe to Grade 3.
- The server receives a keyed origin alias, sanitized labels and structure, a
  fresh PNG, redaction metadata, and no raw page values.
- Detector failure requires a full opaque mask or no request.

Any 1.x change must update `governance/protocol-manifest.json`, the three
contract documents, client/server schemas, positive and negative tests, and the
release evidence. A breaking change requires a new major version and a migration
entry before implementation is merged.
