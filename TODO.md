# TODO

[HUMANS.md](HUMANS.md) and [AGENTS.md](AGENTS.md) describe what engined does.

## AUR packages `engined` and `engined-git`

Decided (NOMAD, 2026-10-17): publish both from the gissf1 AUR account, which its holder cleared for `heft*` and `engined*` only. The release flow is heft's local `release.sh` shape (heft `TODO.md`, "AUR release without the commit-back round trip"), minus `-bin`: the bundle is arch-independent, so `engined` is `arch=('any')`, built from `git+$url.git#tag=v$pkgver` with a real sha256, and needs nothing from CI. Both names are free on the AUR.

### Read

- `src/paths.ts:31-34`: `installDir()` is fixed to `$XDG_DATA_HOME/engined`; a package installs to `/usr/lib/engined`.
- `src/main.ts:449`: `enginesRoot` reads `installDir()`. Take `ENGINED_INSTALL_DIR` (absolute only) ahead of the XDG default, so `install.sh` keeps working unchanged.
- `scripts/engined.service.in`, `engined-probe.*.in`, `engined-tls.service.in`: rendered per user by `scripts/install.sh`; the package ships fixed copies in `/usr/lib/systemd/user/` with `/usr/bin/bun`, `/usr/bin/bunx`, `/usr/bin/docker`, `ENGINED_INSTALL_DIR=/usr/lib/engined`, state under `%h/.local/state/engined`.
- `scripts/install.sh:4` and `AGENTS.md`: "no other install or update path" becomes untrue.
- `.github/workflows/release.yml`: unchanged.

### Traps

- No tag exists yet; `package.json` is 0.1.0, so the first release is `v0.1.0`.
- `bun run build` needs `ENGINED_COMMIT`; the git source has the checkout, so `build()` sets it from `git rev-parse HEAD`.
- pacman cannot enable user units: an `.install` message names `config.example.toml` and `systemctl --user enable --now engined engined-probe.timer`.
- `release.sh` pushes only `engined` and `engined-git`, by name; the account holds other people's packages.
- The engine images are built locally and tuned for Strix Halo, and some are non-commercial or research-licensed (`THIRD_PARTY_NOTICES.md`). The package ships none of them; the PKGBUILD says so.

### Acceptance

- In `archlinux:base-devel` with `bun` from `extra` and no `node_modules`, `makepkg` builds and `bun /usr/lib/engined/main.js --help` runs (bundle build measured working on bun 1.4.3).
- `depends=('bun')`, `optdepends` for `docker`, `bubblewrap` and the agent CLIs, 0BSD packaging `LICENSE`.
- A user unit from the package starts against a copied `config.example.toml` and serves `GET /engined/v1/engines`.
- `install.sh` from a clone still installs and runs as before.
