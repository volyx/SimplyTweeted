# AGENTS.md

Notes for coding agents working in this repo.

## Version control: use `jj`, not `git`

Prefer [Jujutsu](https://jj-vcs.github.io/jj/) for version-control work here —
`jj status`, `jj diff`, `jj describe`, `jj commit`, `jj git push`. Fall back to
`git` only for operations jj has no equivalent for.

**Not yet usable as of 2026-08-01.** `jj` is not installed on this machine and
the repo has no `.jj` directory, so agents currently fall back to `git`. To
switch it on:

```sh
brew install jj
jj git init --colocate    # keeps .git working alongside .jj
```

Once `.jj` exists, use jj commands and delete this paragraph.

## Commits need a Touch ID approval

Commits are SSH-signed with a key held in [Secretive](https://github.com/maxgoedjen/secretive)
(Secure Enclave), so every commit raises a Touch ID prompt. A foreground commit
from an agent blocks until someone approves it and will hit the tool timeout —
run the commit in the background instead, and tell the user to approve the
prompt.

A failure reading `Signing ... failed: communication with agent failed?` means
the prompt was never approved, not that the key is broken.
