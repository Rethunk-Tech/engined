# deb and rpm packages

Debian and Fedora do not package bun, so these packages ship a standalone binary:
`bun build --compile` of `src/main.ts` for `bun-linux-x64` and `bun-linux-arm64`. The
compile embeds the config UI's page and its hashed js/css, so `/usr/bin/engined` is the whole
program (`src/configsvcMain.ts` skips its `chdir` to the assets when running from the compiled
binary's virtual filesystem).

A compiled bun binary acts as bun when `BUN_BE_BUN=1` is set, so `/usr/lib/engined/bunx` is a
two-line wrapper over `engined x`, and the units' `ENGINED_BUNX` points at it.

```sh
packaging/deb-rpm/build.sh x64 out/     # or arm64
```

`build.sh` downloads a pinned nfpm (sha256-checked) into a scratch directory, never onto PATH,
compiles the binary, renders the units with `scripts/install.sh`'s own `render_unit_file`
(then collapses `<bun> main.js` to the binary), and runs `nfpm.yaml` for both formats. The
release workflow runs it for both architectures on a `v*` tag and attaches the four packages
beside the tarball.

Layout matches the AUR package: `/usr/bin/engined`, `/usr/lib/engined/{bunx,engines,Caddyfile.cursor}`,
user units in `/usr/lib/systemd/user`, `/usr/share/engined/config.{example.toml,schema.json}`, docs
under `/usr/share/doc/engined`. Recommends docker, suggests bubblewrap. `postinstall.sh` prints the
same next steps as the AUR `engined.install`.
