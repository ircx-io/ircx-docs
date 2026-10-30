# Contributing

Corrections and new pages are welcome. Open a pull request from a fork.

## Before you open a pull request

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run scan
```

`npm run check` fails when a page breaks one of the file, front-matter or emphasis rules below, and lists the problems it found. CI runs the same commands on every pull request. There is no local preview. GitHub's own view of a Markdown file shows how a change reads, and the ircx.io site checks the Markdown rules and every link when it renders a new commit.

## Pages

Each page is a Markdown file under `content/`.

- File names match `[a-z0-9-]+.md` and folder names match `[a-z0-9-]+`. Every folder has an `index.md`.
- `content/a/b.md` is served at `/help/a/b`, and `content/a/index.md` at `/help/a`. A file `a.md` beside a folder `a/` is an error, because both would be `/help/a`.
- Files are UTF-8, at most 64 KiB each, with at most 200 files and 2 MiB in total. Control characters other than tab and newline, and bidirectional control characters, are refused.

### Front matter

A page starts with front matter between two `---` lines:

```
---
title: Use an IRC client
description: Server, port and TLS settings for connecting with an IRC client.
order: 2
---
```

- `title` is required, 1 to 80 characters.
- `description` is required, 1 to 200 characters.
- `order` is optional, an integer from 0 to 999. Pages in a folder are listed by `order`, then by title.

Each line is `key: value`. One pair of surrounding double quotes is removed. A backslash, an unknown key or a repeated key is an error.

### Markdown

GitHub-flavoured Markdown, with these limits:

- Headings run from `##` to `####`. The page title comes from front matter, so `#` is refused, and so is `#####` and deeper.
- No raw HTML, no HTML comments, no images and no task-list items.
- No character reference outside code, named or numeric, such as `&lt;`, `&amp;`, `&#60;` or `&#x3C;`. The site build refuses one, because a named reference would show as typed and a numeric one turns the other `&` signs in its text into a visible `&amp;`. Write the character itself, as `\<` where a `<` would start a tag. In a code span or a code block the text shows as written.
- A paragraph may hold at most 256 `*`, `_` and `~` characters together.
- Links are one of three kinds:
  - another page, as a relative path to its `.md` file, optionally with a heading: `./irc-client.md#server-settings`;
  - a heading on the same page: `#server-settings`;
  - an `https://` address on one of these hosts: `ircx.io`, `www.rfc-editor.org`, `datatracker.ietf.org`, `creativecommons.org`, `opensource.org`, `docs.github.com`, and `github.com` for this repository only. The address may contain letters, digits and `. _ ~ / -` only.
- Every link to a page or heading must resolve, or the site's build fails.

### Heading ids

A heading's id is its text in lowercase, keeping `a-z` and `0-9`, with each run of spaces and hyphens turned into one `-` and everything else dropped. An empty result becomes `section`. When the id is already taken on the page, is used by the site's layout, or is a name the sanitiser refuses (such as `title` or `links`), the renderer appends `-2`, `-3` and so on until it is free.

### The publication scan

`npm run scan` refuses credential-like strings, local file paths, e-mail addresses, hosts and repositories outside the allowlists, IPv4 addresses and 32-character hex identifiers, in file contents and in file and directory names. It reports the file, line and rule, never the line it matched. A match in a name is reported by that name.

## What we accept

- Write your own text. Do not copy text from other sites or documents.
- Facts about the service are checked by the maintainers before a change is merged.
- Members of the `docs-maintainers` team merge, and every pull request is squash-merged.
- Workflow runs on pull requests from outside contributors wait for a maintainer's approval.

## Licence of contributions

There is no contributor licence agreement. Under section D.6 of the [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service), what you contribute is licensed under this repository's licences: prose under CC BY 4.0 (`LICENSE`) and code under MIT (`LICENSE-CODE`). See the README for which files each covers.
