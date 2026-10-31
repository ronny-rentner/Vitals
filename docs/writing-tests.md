# Writing tests

[Documentation index](../README.md#development) · [Development](development.md#tests)

[Development](development.md#tests) explains how to run the tests and what they replace. This document defines what tests should check.

A test must fail when behavior violates a requirement. Refactoring or changing an incidental name, icon or wording must not break it. When a requirement itself changes, review the test's expectation against that requirement.

## What to test

- Behaviour through the public interface: `Sensors` as the extension uses it, the settings, and what is on screen.
- Rules that must always hold: every category needs a usable icon, for example. Check that requirement without depending on the filename of a particular WiFi icon. Theme overrides and fallback are part of the supported behavior.
- Values computed from inputs: give the machine a known reading and derive the expected value from it.
- Failures, boundaries and lifecycle: a read that fails or hangs, a device that is unplugged, an interval that passes.
- `enable()` and then `disable()` leave nothing behind.
- Cover pure logic, such as `formatter.js`, with many small unit tests. Keep headless Shell tests few because they are slow and fragile.

## What a test may depend on

- Public interfaces, the schema keys and what is observable from outside.
- Replacements only at the boundary of the system: files, programs, network, clock and timers.
- In unit tests, a clock that can advance without waiting for real polling intervals. Shell tests wait for actual UI events and rendering.

## What a test must not depend on

- Private members, names of internal functions, or the order of internal calls.
- Incidental labels, translations, icon filenames, CSS classes or actor structure. Exact text or visible layout belongs in an assertion only when it is the requirement: unit spellings in `tests/formatter.test.js`, for example, or keeping menu actions reachable in a scrolling category.
- Real hardware, except in `tests/shell.test.js`, which is meant to run on it.
- Other tests. Each test or step creates the state it needs and restores what it changed.

## Before writing a test

Name the requirement it protects. Without one, do not write the test.

## Incident report, 2026-10-18

We deleted a large part of the tests because they asserted incidental sensor labels and icon names. Updating those tests after every wording or artwork change protected no requirement and encouraged accepting changed output without checking for regressions. Deleting seven `Sensors` tests and nine Shell steps also removed our checks of battery, storage, network and graphics card values, Refresh, and the row menu. We need to preserve behavioral coverage when removing incidental assertions. See [Development](development.md#tests) for the current test setup.
