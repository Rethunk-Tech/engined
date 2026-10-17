# AUR packaging

This directory is the source of truth for `engined` (built from the release
tag) and `engined-git` (main). The AUR repositories are push targets, never
edited in place. The bundle is architecture-independent, so there is no `-bin`
package.

`LICENSE` here is 0BSD and covers the packaging sources only, not engined: the
AUR submission guidelines require a package source licence in each AUR
repository, and one that is not 0BSD makes the package ineligible for
promotion to the official repositories. Every push copies it in beside
`PKGBUILD`, `.SRCINFO` and `engined.install`.

The AUR account these packages live in also maintains packages that are not
engined's. `release.sh` pushes `engined` by name and nothing else; keep it
that way.

The packaged units are rendered by `scripts/install.sh`'s own
`render_unit_file` at `package()` time, with `/usr/lib/engined` as the install
directory and `%S/engined` as the state directory, so they cannot drift from
the templates.

## Release

Move the changes into `## Unreleased` in `CHANGELOG.md`, then:

```sh
packaging/aur/release.sh tag 0.1.0       # local only
packaging/aur/release.sh publish 0.1.0   # pushes
```

`tag` dates the changelog section, bumps `package.json`, commits, and tags with
the section as the annotation (the release workflow's notes). Nothing else.

`publish` pushes main and the tag in one atomic push, then waits for the
release workflow run on the tag's commit (`gh run watch`). That run builds
`engined-<version>.tar.gz` (the bundle, `engines/`, the unit templates, docs,
`config.schema.json`, and the two source files `install.sh` resolves paths through, under one `engined-<version>/` directory) and attaches it
to the GitHub release. `publish` downloads that asset, writes its sha256 into
`packaging/aur/engined/PKGBUILD`, regenerates `.SRCINFO`, commits
`chore(aur): engined <version>`, and pushes `engined` to the AUR. The PKGBUILD
installs from the extracted tarball and builds nothing, so the checksum is the
asset's and cannot exist before the workflow ran. The `chore(aur)` commit stays
local until the next push to main.

`publish` needs Docker (makepkg runs in `archlinux:base-devel`), `gh` logged in
to the repository, and an SSH key the AUR account accepts. No AUR key is kept
in GitHub.

`engined-git` builds from main with `bun install --frozen-lockfile` and is
pushed by hand on its own cadence: a tag changes nothing in a package whose
`pkgver()` is `git describe`. Regenerate its `.SRCINFO` with
`makepkg --printsrcinfo` before pushing.

Check the result with a fresh clone, not the RPC or cgit, which lag by minutes.
