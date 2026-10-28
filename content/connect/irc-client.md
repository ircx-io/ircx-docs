---
title: Use an IRC client
description: Server, port and TLS settings for connecting with an IRC client.
order: 2
---

## Server settings

Set up your client with the recommended settings:

| Setting | Value |
| --- | --- |
| Server | `chat.ircx.io` |
| Port | `6697` |
| TLS | On |

Let's Encrypt issues the server's certificate for `chat.ircx.io`, so leave certificate verification on in your client.

## Plaintext port

Port 6667 accepts unencrypted connections. Anyone on the network path between you and the server can read everything your client sends there, your nickname and your messages included. Use it only if your client cannot do TLS at all.

## Your nickname

You join as a guest, and the server shows a guest's nickname with `>` in front of it, so `Alice` appears as `>Alice`. Do not type the `>` yourself. The server refuses a nickname that starts with `>` from a client that has not completed an `AUTH` exchange.

## Join a room

Join a room by its name. In a room name that starts with `%#`, write a space as `\b`:

```
JOIN %#The\bLobby
```

See [Lines and escaping](../protocol/lines-and-escaping.md#escapes) for the other escapes.

## The directory is not a chat server

Connect your IRC client to `chat.ircx.io`, not to `dir.ircx.io`. The directory hosts no rooms, and it answers the commands it does not handle, such as `JOIN`, with `421` (unknown command).
