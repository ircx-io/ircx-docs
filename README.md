# ircx.io Help

The content behind the Help pages at https://ircx.io/help: how to connect to the service, notes on the protocol it speaks, and pages about accounts and the legal texts. The pages are Markdown files under `content/`. The ircx.io site renders them from a pinned commit of this repository, so a merged change appears on the site when that pin moves.

The organisation's GitHub App, "ircx.io bot", makes the commits to this repository.

## Commands

You need Node.js 24 (see `.nvmrc`).

```sh
npm ci --ignore-scripts   # install the locked dependencies, running no install scripts
npm run check             # check the pages under content/
npm test                  # the test suite
npm run typecheck         # type-check src/ and test/
npm run scan              # the publication scan over the tracked tree
```

## Layout

| Path | What it holds |
| --- | --- |
| `content/` | The pages, one Markdown file each. A folder's `index.md` is its landing page. |
| `src/` | The content check, the publication scan and the workflow checker. |
| `test/` | Tests, run with `node --test`. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [SECURITY.md](SECURITY.md).

## Licence

- The prose, meaning everything under `content/` and the Markdown files at the root of this repository, is licensed under the [Creative Commons Attribution 4.0 International licence](https://creativecommons.org/licenses/by/4.0/) (`LICENSE`).
- The code, meaning `src/`, `test/`, the configuration files, and the fenced code blocks inside `content/`, is licensed under the [MIT licence](https://opensource.org/license/mit) (`LICENSE-CODE`).

If you reuse the prose, a suitable attribution is: "ircx.io Help (https://github.com/ircx-io/ircx-docs), CC BY 4.0". Say whether you changed it.
