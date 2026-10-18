# AUR packaging

Push targets for `engined` (release tag) and `engined-git` (main). No `-bin`
package. `release.sh` pushes `engined` by name only.

`LICENSE` is 0BSD for these sources; AUR requires it, and a non-0BSD licence
blocks official-repo promotion. Each push copies it with `PKGBUILD`,
`.SRCINFO`, and `engined.install`.

`package()` renders units via `scripts/install.sh` `render_unit_file`
(`/usr/lib/engined`, state `%S/engined`).

## Release

`## Unreleased` in `CHANGELOG.md`, then:

```sh
packaging/aur/release.sh tag 0.1.0       # local only
packaging/aur/release.sh publish 0.1.0   # pushes
```

`tag` dates the changelog, bumps `package.json`, commits, tags.

`publish` pushes main+tag, waits on the release workflow, writes the asset
sha256 into `packaging/aur/engined/PKGBUILD`, regenerates `.SRCINFO`,
commits `chore(aur): engined <version>`, and pushes `engined` to AUR. The
checksum cannot exist before the workflow. The `chore(aur)` commit waits
for the next push to main.

Needs Docker (`archlinux:base-devel`), `gh`, and an AUR SSH key (never in
GitHub).

`engined-git`: `git describe`, `bun install --frozen-lockfile`. Hand-push;
`makepkg --printsrcinfo`. Verify on a fresh clone — RPC and cgit lag.
