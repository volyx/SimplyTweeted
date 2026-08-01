# AGENTS.md

Notes for coding agents working in this repo.

## Version control: use `jj`, not `git`

Use [Jujutsu](https://jj-vcs.github.io/jj/) for version-control work here —
`jj status`, `jj diff`, `jj describe`, `jj commit`, `jj git push`. Fall back to
`git` only for operations jj has no equivalent for.

The repo is colocated (`jj git init --colocate`), so `.git` and `.jj` sit side
by side and git commands still work on the same history. `.jj` hides itself from
git via a `/*` gitignore inside it — it does not belong in the repo's own
`.gitignore`.

There is no `jj push`. Publish with `jj git push`, and move the bookmark first —
a new commit does not advance `main` on its own:

```sh
jj commit -m "…"
jj bookmark set main -r @-
jj git push --remote fork --bookmark main
```

## Commits are signed — and jj does not sign by default

Git here signs every commit (`commit.gpgsign=true`, `gpg.format=ssh`, global
config). **jj ships with `signing.behavior = "keep"` and `signing.backend =
"none"`**, so an unconfigured jj would silently produce unsigned commits in a
repo where everything else is signed. The user-level jj config now mirrors git:

```
signing.behavior = "own"
signing.backend  = "ssh"
signing.key      = ~/.ssh/secretive_signing.pub
```

Check with `jj config list signing` if commits start showing up unsigned.

## Commits need a Touch ID approval

Commits are SSH-signed with a key held in [Secretive](https://github.com/maxgoedjen/secretive)
(Secure Enclave), so every commit raises a Touch ID prompt. A foreground commit
from an agent blocks until someone approves it and will hit the tool timeout —
run the commit in the background instead, and tell the user to approve the
prompt.

A failure reading `Signing ... failed: communication with agent failed?` means
the prompt was never approved, not that the key is broken.
