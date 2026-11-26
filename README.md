# Shared Digital Book Library (demo build)

English build of the project, used for the presentation screenshots. Same code as the
submitted repository, only the interface text and the sample data are in English.

Zero dependencies — Node.js 18+, no `npm install`, no build step.

```bash
node server.js                 # http://localhost:3000
PORT=3100 node server.js       # or pick another port
node test/acceptance.mjs       # 22 acceptance checks (server must be running)
```

## Pages

| URL | Page | What you can do |
|---|---|---|
| `/` | Catalogue | search, filter by status and tag, borrow, return, edit, add, concurrency self-check |
| `/book.html?id=1` | Book detail | stock and version, holders, queue, borrowing history, ratings and reviews |
| `/me.html` | My loans | what you hold, where you are in the queue, reviews you wrote |
| `/stats.html` | Dashboard | titles, copies, on loan, utilisation, most borrowed, tags, recent activity |

## What it demonstrates

- **Optimistic locking.** Every record carries a `version`. Borrow, return and edit must send the
  version the client saw; a stale request gets `409` plus the current record.
- **Retry asymmetry.** A borrow retries once with the fresh version, so the loser of a last-copy
  race joins the queue instead of failing. An edit never retries — a person must re-read the record.
- **FIFO reservations.** Borrowing at zero stock joins a queue; a return is held for the member at
  the head rather than going back on the shelf.
- **Append-only history.** Every add, borrow, return and edit is recorded per book with time and member.
- **Ratings.** One rating and short review per member per book; the average shows on the card.

## API

```
GET    /api/state                 everything the pages need
GET    /api/stats                 totals, utilisation, ranking, tags, recent activity
GET    /api/books/:id             book + queue + history + reviews
POST   /api/books                 add a book (optional tags)
PATCH  /api/books/:id             edit (needs version)
POST   /api/books/:id/borrow      borrow (needs version)
POST   /api/books/:id/return      return (needs version)
POST   /api/books/:id/reviews     review { member, rating, comment }
GET    /api/members/:name         that member's loans, queue positions, reviews
POST   /api/reset                 restore the sample data
```

Sample data lives in `data.json` (git-ignored) and survives a restart.

## License

Extends [bradtraversy/bookmarker](https://github.com/bradtraversy/bookmarker) (MIT).
Original copyright belongs to Brad Traversy; the added code is released under the same licence.
