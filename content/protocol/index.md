---
title: Protocol notes
description: Notes for client authors on how ircx.io behaves on the wire.
order: 2
---

These pages describe how ircx.io behaves on the wire, for people who write or configure IRC clients. They build on two documents:

- [RFC 1459](https://www.rfc-editor.org/rfc/rfc1459.html), Internet Relay Chat Protocol.
- [draft-pfenning-irc-extensions-04](https://datatracker.ietf.org/doc/html/draft-pfenning-irc-extensions-04), the IRCX extensions.

## Pages

- [Dialects and negotiation](./dialects.md): plain IRC, IRCX mode and `IRCVERS`.
- [Lines and escaping](./lines-and-escaping.md): message format and the IRCX escapes.
- [Directory and redirect](./directory-redirect.md): how a client finds the chat server for a room.
