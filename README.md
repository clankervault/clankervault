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
`confirmed`/`high` by default; unconfirmed records come from an assistant
proposing memory live through the MCP server's `remember` tool, or from
`vault mine` reading your AI session transcripts (see MCP server and Mining
below), and only take effect once a human confirms them.

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

`vault sync` reconciles a vault edited from more than one device, without
git. In folder mode there is no server and no cloud account: the remote is
just a folder, so anything that already keeps a folder in sync between your
machines works, iCloud Drive, Dropbox, a NAS mount, a USB drive. The http
mode below (see Self-hosting) talks to your own self-hosted `vault serve`
instead. `vault` only ever writes encrypted objects into whichever remote you
configured; the storage side (v1 ships `dir`, a plain directory backend, and
`http`, talking to `vault serve`) is a small pluggable interface, open to
further backends without changing anything else.

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

## MCP server

`vault compile` writes files once, ahead of time; `vault mcp` serves the
vault live, on demand, to anything that speaks the Model Context Protocol
(spec §5). This is the path for chat assistants that cannot read a compiled
file off disk, and for any setup running multiple accounts of the same
assistant, since each MCP client identifies itself in the handshake and gets
its own provenance trail on what it wrote, rather than every account sharing
one compiled file.

Run it with `vault mcp`, or point a client at it directly. For Claude
Desktop or Claude Code, add to the MCP server config:

```json
{
  "mcpServers": {
    "vault": {
      "command": "vault",
      "args": ["mcp", "--vault", "/path/to/your/vault"]
    }
  }
}
```

Drop `"--vault", "/path/to/your/vault"` if `VAULT_DIR` is already set, or if
you are fine with the default `~/vault`.

Four tools are exposed:

| Tool | Arguments | What it does |
|------|-----------|----------------|
| `get_context` | `project?`, `lenses?` | Compiled context for a project: facts, recipes, decisions, taste, state. Resolves the project the same way the CLI does (`--project`-style ref, else current directory) and falls back to just the user's profile and global taste plus a list of known projects when nothing resolves. |
| `get_state` | `project` | The project's current work in progress (`state.md`), or "Nothing in progress." when it is empty. |
| `remember` | `project?`, `type`, `title`, `body?`, `scope?`, `tags?` | Writes a new record from inside a conversation. |
| `search` | `query` | Keyword search across every project's records. |

**Trust model.** A record written through `remember` is saved with
`status: unconfirmed` and provenance `source.tool: mcp:<client-name>`, and it
stays out of every compiled file and out of `get_context` until a human runs
`vault confirm <id>`, the same gate that already applies to any other
unconfirmed record. An assistant proposing memory about you can never make
that memory take effect on its own. `get_context` also takes a `lenses`
argument: pass `lenses: false` when you want project facts and state without
the personal layer (`profile` and `taste`), for a context you plan to hand to
someone else or paste somewhere less private.

## Self-hosting

`vault serve` runs a small server that gives you two things from one process:
an encrypted sync remote (the `--url` alternative to a shared folder, see
Sync above) and a remote MCP endpoint at `/v1/mcp` for chat assistants that
can reach the network but cannot launch a local `vault mcp` stdio process,
a hosted assistant, a phone, a teammate's machine.

```bash
vault serve --data /path/to/server-data --port 8484
```

**Token model.** Every request needs `Authorization: Bearer <token>`. The
token comes from `--token`, or `VAULT_SERVER_TOKEN` in the environment, or,
if neither is set, a random one generated on first run and saved to
`<data>/token` (owner-only, mode 0600), printed once to stdout so you can
copy it to your devices. There is no per-user account system: one token
per server, shared across every device you point at it.

Point a device at it the same way you would a shared folder:

```bash
vault sync setup --url https://your-server:8484 --token <token> --passphrase <same-on-every-device>
vault sync
```

**The E2E tradeoff.** By default, with no `VAULT_PASSPHRASE` in the server's
own environment, `vault serve` is a pure ciphertext store: exactly like
syncing over a folder, it never sees plaintext, and `/v1/mcp` answers `503`
rather than pretending to work. Setting `VAULT_PASSPHRASE` on the server
enables `/v1/mcp`: the server decrypts a private working copy for itself
(the replica, kept under `<data>/replica`, refreshed from the ciphertext
store roughly every 15 seconds) so it has something to answer MCP tool
calls with. That is a real, deliberate tradeoff, not a hidden one: it moves
trust from "nothing but your own devices ever sees plaintext" to "your
server, which you operate, sees plaintext too", and the startup log always
states which mode is active:

```
MCP endpoint: enabled at /v1/mcp
MCP endpoint: disabled (set VAULT_PASSPHRASE to enable)
```

**Docker.** The image builds from source (`npm ci`, `tsc`, then
`npm prune --omit=dev`) and its entrypoint is `vault serve --data /data
--port 8484`:

```bash
docker build -t vault-server .
docker run -d \
  -p 8484:8484 \
  -v vault-data:/data \
  -e VAULT_SERVER_TOKEN=<pick-a-long-random-token> \
  -e VAULT_PASSPHRASE=<optional, enables remote MCP> \
  vault-server
```

`/data` holds the ciphertext store, the token file if you did not supply
one, and, only when `VAULT_PASSPHRASE` is set, the decrypted replica: back
it up like a vault, and treat the container's filesystem like you would any
server that can hold decrypted user data when that variable is set.

This is the self-hostable half of what a hosted vault service would need,
one server, one token, your own machine or VPS. Running this for other
people, multi-tenant accounts, billing, TLS termination, one-click deploy,
is not built here; it is the natural paid tier on top, not a requirement to
use vault yourself.

## Mining

`vault mine` finds durable, reusable knowledge already sitting in your AI
coding sessions and proposes it as `unconfirmed` records, so you do not have
to write everything into the vault by hand. The first reader is Claude Code:
it reads the JSONL transcripts Claude Code already keeps under
`~/.claude/projects/`, incrementally, one file at a time, tracking a byte
offset per file so a run only ever looks at what is new since the last one.
A trailing, not-yet-complete line is left for next time rather than parsed
half-written.

Each new chunk of transcript text is resolved to a project the same way the
CLI already does (`.vault-id`, `device.yaml`, git remote, path prefix, from
the session's working directory), then handed to an extractor along with the
titles of that project's existing, non-superseded records, so it can skip
anything already known and flag genuine contradictions instead of silently
duplicating. The shipped extractor shells out to the `claude` CLI already
installed and logged into your own account, no separate API key, with a
prompt that frames the transcript explicitly as data to analyze, not
instructions to follow, and asks for at most five items and an empty array
over noise.

```bash
vault mine                 # one pass over new transcript data
vault mine --dry-run       # show what would be created, write nothing
vault mine --watch         # keep running, mine every --interval seconds (default 300)
```

Mined records are born `unconfirmed`, carry
`source: { tool: 'claude-code', transcript: <path>, approx_range: 'bytes <from>-<to>' }`,
and never compile or show up in `get_context` until a human confirms them,
same as anything the MCP server proposes. Something that contradicts an
existing record comes back tagged `contradicts`, its body prefixed with
`Contradicts: <old title>`, for you to resolve by hand with `vault supersede`;
mined data never auto-supersedes a confirmed record.

Two ways out of `unconfirmed`: `vault confirm <id>` by hand, or
`vault settle --days <n>` (default 14), which confirms every `unconfirmed`,
`confidence: high` record older than that many days, for one project with
`--project` or across all of them without it. `vault settle` never touches
medium- or low-confidence records, and never touches a record whose
`source.tool` starts with `mcp`: anything an assistant proposed live through
the MCP server still needs an explicit `vault confirm`.

Per-file offsets live in `.mine/offsets.json`, already on the sync exclusion
list (per-device, like `device.yaml`), since what a given machine has
already read out of its own `~/.claude/projects/` has no meaning on another
one.

## Roadmap

Phase 1 (the format plus this CLI), phase 2 (sync), phase 3 (the MCP server),
phase 4 (mining) and phase 5 (the self-hostable server: HTTP sync remote plus
remote MCP endpoint, see Self-hosting above) are implemented and tested.
Still out of scope, and coming later:

- **More mining readers**: Codex session logs, Cursor, best-effort, meant to
  slot in behind the same reader/extractor interfaces without changing
  `vault mine` or the CLI.
- **Hosted, multi-tenant service**: someone else's `vault serve` running
  your vault for you, with accounts, billing and TLS handled for you. The
  server code for that already exists and is self-hostable today; only the
  multi-tenant operation of it is not built, and is the natural paid tier.

The on-disk format and this CLI's commands are meant to stay stable through
all of that: a vault you start today should keep working unmodified once
those layers land. The project is MIT licensed.
