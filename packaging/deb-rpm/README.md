# deb and rpm packages

`bun build --compile` of `src/main.ts` for `bun-linux-x64` and
`bun-linux-arm64`. The binary embeds the config UI (`src/configsvcMain.ts`
skips its assets `chdir` on that VFS). `BUN_BE_BUN=1` makes it bun, so
`/usr/lib/engined/bunx` wraps `engined x` and units set `ENGINED_BUNX`.

```sh
packaging/deb-rpm/build.sh x64 out/     # or arm64
```

`build.sh` pins nfpm in a scratch dir, compiles, renders units via
`scripts/install.sh` `render_unit_file` (collapses `<bun> main.js` to the
binary), writes `engined-linux-{amd64,arm64}.tar.gz`, and runs `nfpm.yaml`.
The `v*` workflow attaches the archives, the four packages, and `SHA256SUMS`.

Layout matches AUR (`/usr/bin/engined`,
`/usr/lib/engined/{bunx,engines,Caddyfile.cursor}`, user units,
`/usr/share/engined/config.{example.toml,schema.json}`, docs). Recommends
docker, suggests bubblewrap. `postinstall.sh` matches AUR `engined.install`.
