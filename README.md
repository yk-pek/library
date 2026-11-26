# Alternet Library

A library the community stocks itself. Anyone with a wallet can add a reading they think is worth other people's time. Readings are kept in full, on shelves by topic, each with a note from whoever shelved it. Plain server-rendered HTML with a reading-room look: a green masthead, spine labels for the shelves, Public Sans for signage and Newsreader for text. Both fonts are served from `public/fonts` (SIL Open Font License, see `public/fonts/LICENSE.txt`).

## What it does

- **Readings:** title, author, year, shelf, tags, an optional link to the original, the contributor's "why read this" note, and the full text (up to 400,000 characters). The text is plain text with a small subset of Markdown: headings, quotations, lists, rules, italic, bold, fenced blocks that keep line breaks, and bare `https://` links. Everything is escaped first; no HTML or pictures.
- **Open shelf:** a reading is public the moment it is added. The contributor can edit it or take it down. Contributors tick a box to confirm the text is theirs, in the public domain, or licensed for sharing.
- **Shelves and tags:** every reading sits on one shelf and can carry up to five tags. Shelves, tags and contributors each have a page, sortable by newest or most recommended.
- **Recommend:** one wallet, one recommendation per reading. It can be withdrawn.
- **Comments:** a flat thread under each reading. A comment can be removed by its author or a librarian.
- **Search:** title, author, note, tags and the text itself.
- **Librarians' desk (`/desk`):** only wallets on the librarian list can reach it. Librarians can edit or take down any reading, remove any comment, put a removed reading back or delete it for good, manage shelves, and add or remove other librarians. A removed reading stays visible to librarians only.

## Stack

- Node.js + Express 5, no build step
- PostgreSQL (tables are created on startup)
- Wallet sign-in: one-time message with a nonce, signed with `personal_sign`, checked with `ethers.verifyMessage`, then a `__Host-library` session cookie (Secure, HttpOnly, SameSite=Lax). The library never asks a wallet to send anything.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection URL (required) |
| `INITIAL_LIBRARIAN` | Wallet address of the first librarian. Used only while the librarian list is empty. |
| `NETWORK_LABEL` | Shown in the banner. Defaults to `testnet`. |
| `CHAIN_ID` | Chain ID written into the sign-in message. Defaults to `1`. |

## Run

```sh
npm install
DATABASE_URL=postgres://user:pass@localhost/library INITIAL_LIBRARIAN=0x... PORT=3000 npm start
npm test   # checks the text renderer
```

## Deploy on SILOS

Node.js silo built from this repo, with `DATABASE_URL={{library-db.url}}` pointing at a Postgres silo named `library-db`.
