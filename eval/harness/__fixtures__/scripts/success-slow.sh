#!/bin/sh
# checkScenario test fixture: sleeps for longer than any reasonable test
# timeout, so a small `timeoutMs` triggers the timeout branch.
sleep 5
exit 0
