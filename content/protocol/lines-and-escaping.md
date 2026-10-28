---
title: Lines and escaping
description: The IRC message format and the IRCX escapes used in room names and binary parameters.
order: 2
---

## Message format

A message is one line ending in CR LF, with its parameters separated by spaces. The last parameter may begin with `:`, and then it may contain spaces ([RFC 1459 sections 2.3 and 2.3.1](https://www.rfc-editor.org/rfc/rfc1459.html#section-2.3)).

RFC 1459 limits a line to 512 bytes, CR LF included. This server states the longest line it accepts in the `maxmsg` field of [the `800` reply](./dialects.md#the-800-reply).

## Escapes

Room names and binary parameters use the IRCX escapes, so a value that holds a space, a comma or a control byte still travels as one parameter. The server decodes these seven:

| Escape | Byte |
| --- | --- |
| `\b` | space |
| `\c` | comma |
| `\\` | backslash |
| `\r` | CR |
| `\n` | LF |
| `\t` | tab |
| `\0` | NUL |

The IRCX draft's own table, Table 1 in [section 3](https://datatracker.ietf.org/doc/html/draft-pfenning-irc-extensions-04#section-3), lists only the first six.

On the wire, the room `%#The Lobby` is written `%#The\bLobby`.
