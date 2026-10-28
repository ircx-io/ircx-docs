---
title: Directory and redirect
description: How a client asks the directory for a room's chat server and follows the answer.
order: 3
---

## On the directory

A nickname alone completes registration on the directory server. Until then, the directory refuses `FINDS` with `451`.

## FINDS and 613

`FINDS <room>` asks which chat server holds a room, and the directory answers with `613` and that server's host and port:

```
613 <nick> :<host> <port>
```

For example:

```
FINDS %#The\bLobby
613 Alice :chat.ircx.io 6697
```

## Which port you are sent to

A client that reached the directory over TLS is sent the chat server's TLS port.

A client that reached the directory on its plaintext port, 6667, is sent the chat server's plaintext port, and the whole session stays unencrypted. Anyone on the network path can read everything the client sends, its nickname and messages included.

## After the redirect

The client connects to the host and port in the `613` reply, registers there and joins the room. The directory itself hosts no rooms.
