#!/bin/sh
# Test fixture: always exits 0. checkScenario tests assert on this exit code;
# they do NOT exercise the agent. Real scenarios in eval/scenarios/ inspect
# the workdir to determine pass/fail.
exit 0
