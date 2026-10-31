# Writing tests

[Documentation index](../README.md#development) · [Development](development.md#tests)

How the tests are run and what they replace is in [development.md](development.md#tests). This file holds the rules for what a test checks.

A test must fail when behavior violates a requirement. Refactoring or changing an incidental name, icon or wording must not break it. When a requirement itself changes, review the test's expectation against that requirement.

## What to test

- Behaviour through the public interface: `Sensors` as the extension uses it, the settings, and what is on screen.
- Rules as invariants: every category has a usable icon, for example, without asserting the incidental filename of a particular WiFi signal icon. Theme overrides and fallback are part of the supported behavior.
- Values computed from inputs: a known reading goes into the machine, and the expected value is derived from it.
- Failures, boundaries and lifecycle: a read that fails or hangs, a device that is unplugged, an interval that passes.
- `enable()` and then `disable()` leave nothing behind.
- Pure logic, such as `formatter.js`, gets many small unit tests. Tests in a headless Shell stay few, because they are slow and fragile.

## What a test may depend on

- Public interfaces, the schema keys and what is observable from outside.
- Replacements only at the boundary of the system: files, programs, network, clock and timers.
- In unit tests, a clock the test skips forward instead of waiting for polling intervals. Shell tests wait for real UI events and rendering.

## What a test must not depend on

- Private members, names of internal functions, or the order of internal calls.
- Incidental labels, translations, icon filenames, CSS classes or actor structure. Exact text or visible layout belongs in an assertion only when it is the requirement: unit spellings in `tests/formatter.test.js`, for example, or keeping menu actions reachable in a scrolling category.
- Real hardware, except in `tests/shell.test.js`, which is meant to run on it.
- Other tests. Each test or step creates the state it needs and puts back what it changed.

## Before writing a test

Name the requirement it protects. Without one, do not write the test.

## Incident report, 2026-10-18

A large part of the tests had to be deleted because they asserted incidental sensor labels and icon names. Updating those tests after every wording or artwork change protected no requirement and encouraged accepting changed output without checking for regressions. At the time, deleting seven `Sensors` tests and nine Shell steps also removed the checks of battery, storage, network and graphics card values, Refresh, and the row menu. The lesson is to preserve behavioral coverage while removing incidental assertions. The current test setup is documented in [Development](development.md#tests).
