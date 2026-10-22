# Counter that refuses to wrap

A `Counter` holds one number. It can be set to any value, and incremented.

Incrementing at the largest value the type can hold must **revert** rather than return
zero. That is the whole requirement, and it is checkable without asking anyone's opinion:
set the counter to the maximum, increment it, and either the call is refused or it is not.

Two tests pin this down and both must pass:

- the value that was set is the value that is read back;
- incrementing at the maximum reverts, and the stored value is unchanged.

## Why this trial exists

The suite above is the same bytes a verifier fetches and re-executes on a clean bench.
Nothing about the outcome depends on the machine that produced the claim.
