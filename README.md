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

`vault dev` (via `npm run dev`) runs the CLI straight from `src/cli.ts` with
`tsx`, no build step needed, for local development.

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

## Roadmap

Phase 1 is the format plus this CLI: everything above is implemented and
tested. Explicitly out of scope for phase 1, and coming later:

- **Sync**: reconciling a vault edited from more than one device, including
  conflicting `state.md` writes.
- **MCP server**: structured, on-demand querying of the vault instead of a
  full recompile per tool.
- **Mining**: proposing `unconfirmed` records straight from AI conversation
  transcripts instead of writing them by hand.

The on-disk format and this CLI's commands are meant to stay stable through
all of that: a vault you start today should keep working unmodified once
those layers land. The project is MIT licensed.
