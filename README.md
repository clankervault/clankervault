# vault

Wherever you talk to AI, you're talking to someone who knows you.

`vault` is a portable memory layer for AI coding and creative tools. You keep one
plain markdown vault on disk, in a format you own and can read without any
tool. `vault compile` turns it into the native context files each assistant
already looks for: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`. Write your facts,
recipes, decisions and taste once, and every tool you switch to picks up the
same memory instead of starting from zero.

## The five record kinds

Everything you write into a project is one of these. Four are append-only
(you never edit an old one, you supersede it); `state` is the one file you
overwrite directly, because it tracks what is happening right now.

| Kind | ID prefix | Mutability | What it holds |
|------|-----------|------------|----------------|
| `fact` | `fct` | append-only | Stable facts: stack, endpoints, accounts, constraints |
| `recipe` | `rcp` | append-only | How something is done here: repeatable steps |
| `decision` | `dec` | append-only | A choice made, and why, so it does not get relitigated |
| `taste` | `tst` | append-only | Preferences and style: tone, conventions, things to avoid |
| `state` | (none, one `state.md`) | mutable, overwritten | What is in progress right now |

`fact`, `recipe`, `decision` and `taste` records also carry `status`
(`unconfirmed`, `confirmed` or `superseded`) and `confidence`
(`high`, `medium`, `low`). Records written by hand through `vault add` are
`confirmed`/`high` by default; unconfirmed records are for a future mining
layer that proposes memory from AI transcripts (see Roadmap).

## Vault structure

```
~/vault/                    (default; override with VAULT_DIR)
├── vault.yaml              spec version, compile.token_budget
├── device.yaml             per-device, never synced (see Anchors below)
├── me/
│   ├── profile.md          who you are, tone and language preferences
│   ├── taste/              global taste files, one concern per file
│   └── skills/
└── projects/
    └── <project-id>/
        ├── project.md      identity + facts, frontmatter: id, name, aliases, kind, roots
        ├── state.md        the one mutable file
        └── records/
            └── <date>-<slug>.md   one fact/recipe/decision/taste record
```

## Install

This is phase 1, unreleased software: the package is not on the npm registry
yet, and the name `vault-cli` is already taken by an unrelated project there,
so it will need a different published name before `npm install -g` works
as-is. For now, install from source:

```bash
git clone <this repo> vault-cli && cd vault-cli
npm install
npm run build
npm link          # puts `vault` on your PATH
```

During development you can run the CLI straight from `src/cli.ts` with `tsx`,
no build step needed: `npm run dev -- <args>` (the `--` passes the arguments
through), e.g. `npm run dev -- init ~/vault`.

## Quickstart

```bash
vault init                                    # creates ~/vault
vault project new "My App" --root ~/dev/my-app
cd ~/dev/my-app
vault add decision "Use Postgres over SQLite" -b "need concurrent writers"
vault compile                                 # writes CLAUDE.md, AGENTS.md, .cursorrules here
```

`vault compile` writes into the current directory by default (`--out <dir>`
to target elsewhere) and always stamps a `GENERATED` header, because these
files are disposable views of the vault, not the source of truth. Add them to
your project's `.gitignore`; the vault itself is what you keep.

## Append-only and supersede

Records are never edited in place. When you change your mind, you run
`vault supersede <old-id> "<new title>"`: it writes a brand new record, links
it back with `supersedes`, and flips the old record's `status` to
`superseded` and `superseded_by` to the new id. The old body is left
untouched, so the history of what you used to believe, and when it changed,
stays on disk. Superseded records are skipped at compile time.

`state.md` is the deliberate exception: `vault state "<text>"` overwrites it
directly, because "what I'm doing right now" is not something worth
version-history for, it just needs to be current.

## Project identity

A project is identified by a stable generated id (`<slug>-<4 hex chars>`,
e.g. `my-app-a1b2`), and `vault` resolves which project you mean from your
current directory through, in order:

1. a `.vault-id` file (containing just the project id) anywhere from your cwd
   up to the filesystem root
2. this device's `projects` map in `device.yaml` (`project-id: /local/path`)
3. a matching git remote, if any of the project's `roots` recorded one
4. a path prefix match against the project's recorded `roots`

Pass `--project <id-or-name>` to any command to skip resolution entirely.
`--root` and `--git` on `vault project new` are how you record roots; they
are repeatable flags, so a project can be recognized from more than one
checkout or remote.

## Anchors and availability

Paths written into records should never be hardcoded absolute paths, because
a vault is meant to move between machines. Instead you write `{project_root}`
or a free-form `{name}` anchor, and `device.yaml`, which is per-device and
never synced, resolves them locally: `projects` maps `{project_root}` per
project id, `anchors` maps any other `{name}` to wherever it lives on this
machine (an external drive, a NAS mount, and so on).

This is also why a record can carry `availability` frontmatter: a per-device
map of where an asset actually sits, or `null` if it is confirmed absent
there. At compile time this renders as a contextual note, e.g. "NOT on this
device (mini); macbook: /path, nas: /path". The vault never syncs the assets
themselves, it syncs knowledge about them: where they are, and where they
are not, on whichever device you are compiling from.

## Token budget and priorities

`vault compile` condenses every record to one line (title, first meaningful
body line, id reference) and fits as many as it can into `compile.token_budget`
from `vault.yaml` (default 4000, override per run with `--budget`). Project
identity, your profile, `state.md`, global taste and unconfirmed-but-high-confidence
records always ship in full; only per-type record lines get cut once the
budget runs out, kept in this order (leftmost survives longest, rightmost is
cut first):

- `code` projects: state > decisions > recipes > taste > facts
- `creative` projects: state > taste > recipes > decisions > facts

Nothing is deleted: cut lines just do not make it into this particular
compile. Raise `compile.token_budget` in `vault.yaml`, or the record still
lives in `projects/<id>/records/` on disk.

## Adapters

Each output target is a small, pluggable module implementing:

```ts
interface Adapter {
  name: string;
  filename: string;
  render(ctx: CompiledContext): string;
}
```

`src/adapters/index.ts` holds the registry (`adapters`, `getAdapter`) and a
shared `renderMarkdownBody` helper used by the markdown-flavored targets.
Shipped today: `claude` (`CLAUDE.md`), `agents` (`AGENTS.md`) and `cursor`
(`.cursorrules`). Adding a new tool means writing one more adapter file and
registering it, nothing else in the CLI or compiler needs to change.

## Sync

`vault sync` reconciles a vault edited from more than one device, without git
and without a server. There is no cloud service to sign up for: the remote
is just a folder, so anything that already keeps a folder in sync between
your machines works, iCloud Drive, Dropbox, a NAS mount, a USB drive. `vault`
only ever writes encrypted objects into that folder; the storage side (v1
ships `dir`, a plain directory backend) is a small pluggable interface, so a
future backend could talk to an actual server without changing anything else.

Everything that leaves this machine is end-to-end encrypted first: file
contents, file paths and the manifest that lists them are all encrypted with
a key derived from your passphrase, so whatever holds the remote folder
(iCloud, a NAS, a USB stick you lose) never sees plaintext content or even
readable filenames. Only a random salt sits on the remote unencrypted, since
key derivation needs it.

Setup on two devices, once each, pointing at the same remote path with the
same passphrase:

```bash
vault sync setup --path /path/to/shared/folder --passphrase <same-on-every-device>
```

Omit `--passphrase` and set `VAULT_PASSPHRASE` in your shell environment
instead if you would rather not have it sitting in `device.yaml`. Either
way, the passphrase must be identical on every device: it is what lets two
machines decrypt each other's objects and is never itself transmitted.

Then, on any device:

```bash
vault sync              # one-shot: pull and push whatever changed, print a summary
vault sync --watch      # keep running: initial sync, then sync on every local change
                         # (1.5s debounce) plus a periodic sync every --interval seconds (default 30)
```

`--watch` runs until you stop it (Ctrl+C) and is meant for a machine you
leave open, so continuous small edits go out as continuous small diffs
instead of one large sync later.

**Conflict semantics.** The four append-only record kinds merge for free:
each record is its own file with a generated name, so two devices adding
records under `records/` never collide. A true conflict can only happen on
a file you hand-edit directly and that keeps the same path across devices,
`state.md`, `me/profile.md`, a project's `project.md`, or `vault.yaml`,
when both devices change it since the last sync. `vault sync` resolves that
with last-write-wins by modification time, and the losing version is never
silently discarded: it is written next to the file it lost to as a
timestamped `<name>.conflict-<device>-<stamp>.md` copy, which also syncs to
every other device, so you can always go read what the other side had and
recover it by hand if last-write-wins picked wrong.

**Never synced**, by design, spec §7: `device.yaml` (per-device settings:
device name, anchors, project root map, sync config itself), `.sync/`
(this device's local sync state), `.mine/`, and `.DS_Store`. These describe
this machine, not the vault's content, so they stay local on every device.

**Known limitations**, not solved in this phase: last-write-wins depends on
roughly sane, roughly synchronized clocks across your devices, a device with
a badly wrong clock can win conflicts it should lose. The directory backend's
compare-and-swap on the manifest is best-effort, safe against the concurrent-
write races this codebase creates and tests, but not a guarantee against every
possible failure mode of arbitrary third-party sync software (iCloud, Dropbox)
racing underneath it. The passphrase, when saved with `--passphrase` instead
of `VAULT_PASSPHRASE`, sits in `device.yaml` in plaintext on that device.

## Roadmap

Phase 1 (the format plus this CLI) and phase 2 (sync) are implemented and
tested. Still out of scope, and coming later:

- **MCP server**: structured, on-demand querying of the vault instead of a
  full recompile per tool.
- **Mining**: proposing `unconfirmed` records straight from AI conversation
  transcripts instead of writing them by hand.

The on-disk format and this CLI's commands are meant to stay stable through
all of that: a vault you start today should keep working unmodified once
those layers land. The project is MIT licensed.
