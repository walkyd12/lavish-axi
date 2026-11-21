# Hub peers - evidence

A real two-server run on loopback, 2026-11-17, from this branch:

- Peer server on `127.0.0.1:47073` (own state dir) with two boards.
- Hub server on `127.0.0.1:42167` (own state dir) with two boards and
  `LAVISH_AXI_HUB_PEERS="walkmate=http://127.0.0.1:47073,offline=http://127.0.0.1:9"`.
- Chromium 145 headless, driven by `chrome-devtools-axi`.

| File                               | Shows                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hub-phone.png`                    | The hub at 390 px wide: its own two boards (Open, History, Close), the two walkmate boards (badge "On walkmate", only "Open on walkmate"), and the note that `offline` is not answering. |
| `hub-phone-full.png`               | The same page from the top.                                                                                                                                                              |
| `board-annotation-and-comment.png` | A same-origin board under the new `frame-src 'self'` header, with an element annotation open; the annotation and a composer comment both reached `/api/<key>/conversation`.              |

Frame-navigation check: a board button running `location.href = "http://localhost:<sink>/?data=secret"`
inside the editor's iframe was refused with `Framing 'http://localhost:<sink>/' violates ... "frame-src 'self'"`,
and the sink logged no request. Control: the same board in a sandboxed iframe on a page without that header
reached the sink with `GET /?data=secret`.
