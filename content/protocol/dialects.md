---
title: Dialects and negotiation
description: Plain IRC registration, IRCX mode, ISIRCX and IRCVERS on the chat server.
order: 1
---

## Plain IRC

A plain IRC client registers by sending `NICK` and `USER`, as in [RFC 1459 sections 4.1.2 and 4.1.3](https://www.rfc-editor.org/rfc/rfc1459.html#section-4.1.2). Registration completes once the server has both.

## Turning IRCX mode on

`IRCX` turns IRCX mode on for the connection, and the chat server answers with numeric `800` ([draft section 5.6](https://datatracker.ietf.org/doc/html/draft-pfenning-irc-extensions-04#section-5.6)).

To ask whether the server speaks IRCX without turning the mode on, send `MODE ISIRCX` before registration or `ISIRCX` after it. Either one gets `800` back ([draft sections 5.7 and 5.9](https://datatracker.ietf.org/doc/html/draft-pfenning-irc-extensions-04#section-5.7)).

## IRCVERS

Sent before registration, `IRCVERS <version> <client>` selects a protocol dialect, `IRC2` to `IRC8`, and the chat server answers with `800`. After registration the server refuses it with `462`.

## The 800 reply

The draft defines the fields of `800` in [section 9.1](https://datatracker.ietf.org/doc/html/draft-pfenning-irc-extensions-04#section-9.1):

```
800 <nick> <state> <version> <package-list> <maxmsg> <option-list>
```

- `state` is `1` when IRCX mode is on.
- `package-list` names the sign-in methods the server offers.
- `maxmsg` is the longest line the server accepts.

The package list and the line length are server settings, so read them from the reply instead of hard-coding them.
