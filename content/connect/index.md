---
title: Connecting
description: How the directory and chat servers fit together, and the ways to reach a room.
order: 1
---

## Two servers

Rooms live on the chat server, `chat.ircx.io`. The directory server, `dir.ircx.io`, knows which chat server holds each room and tells a client where to go.

## From a browser

The web chat at ircx.io does the directory step for you and then joins the room on the chat server. See [Chat in your browser](./browser.md).

The web chat's secure WebSocket endpoints accept connections only from the ircx.io site, so another website cannot open a chat connection on your behalf.

## From an IRC client

Point your client at the chat server. [Use an IRC client](./irc-client.md) has the settings.
