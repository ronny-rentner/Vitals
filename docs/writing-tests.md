# Writing tests

How the tests are run and what they replace is in [development.md](development.md#tests). This file holds the rules for what a test checks.

A test must fail only when a requirement changes. A refactor, a rename, a new icon or new wording must break no test. A test that breaks on such a change checks how the code works, not what it does.

## What to test

- Behaviour through the public interface: `Sensors` as the extension uses it, the settings, and what is on screen.
- Rules as invariants, not as examples: "every sensor icon is found in Vitals' `icons/` folder" holds for every icon; "the WiFi icon is `vitals-wifi-signal-good`" does not.
- Values computed from inputs: a known reading goes into the machine, and the expected value is derived from it.
- Failures, boundaries and lifecycle: a read that fails or hangs, a device that is unplugged, an interval that passes.
- `enable()` and then `disable()` leave nothing behind.
- Pure logic, such as `formatter.js`, gets many small unit tests. Tests in a headless Shell stay few, because they are slow and fragile.

## What a test may depend on

- Public interfaces, the schema keys and what is observable from outside.
- Replacements only at the boundary of the system: files, programs, network, clock and timers.
- A clock the test skips forward, never real waiting.

## What a test must not depend on

- Private members, names of internal functions, or the order of internal calls.
- Labels, translations, icon names, CSS classes or layout. The exception is text whose exact spelling is the requirement, such as the units in `tests/formatter.test.js`.
- Real hardware, except in `tests/shell.test.js`, which is meant to run on it.
- Other tests. Each test or step creates the state it needs and puts back what it changed.

## Before writing a test

Name the requirement it protects. Without one, do not write the test.

## Incident report, 2026-10-18

A severe incident: a large part of the tests had to be deleted. They named sensor labels and icon names, so changing a label or an icon meant changing those tests as well: extra work that protected no requirement. Worse, it trains a habit. Whoever updates the tests after every change of a label or an icon also updates them when a change breaks something, and then the tests catch nothing. Seven tests of `Sensors` and nine steps of the Shell tests were deleted, and with them every check of battery, storage, network and graphics card values, Refresh, and the row menu.
