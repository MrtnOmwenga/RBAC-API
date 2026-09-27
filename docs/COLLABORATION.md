# Collaboration and permissions

How RBAC-API lets several people edit the same document live while each of them sees and changes
only what their permissions allow. It covers why permissions work per section, how words inside a
section are classified, how concurrent edits merge, and how permission changes reach connections
that are already open, including a race condition and how it's closed.

Code: `src/realtime/` (including `projection.ts`), `src/briefings/`, `src/policy/policy.ts`. Tests:
`test/realtime.e2e-spec.ts`, `test/marked-words.e2e-spec.ts`, `test/briefings.e2e-spec.ts`,
`src/realtime/projection.spec.ts`, `test/browser/redacted.spec.ts`.

## 1. Permissions on parts of a document

### What exists: per-section classification

A document is an ordered list of **sections**. Each section has a classification (unclassified,
confidential, secret, top secret) and its own collaborative text. A member may see a section when
they have access to the document (role or share) **and** clearance at or above its classification.

The important design choice: **each section is a separate collaborative document on the server.**
A member who isn't cleared for a section is never connected to it, so its text never leaves the
server. The REST API sends that section only as a redaction: no heading, no text, and a length
rounded up to 40 characters so the page keeps its shape. A browser test records everything the
Intern's page receives, every HTTP response and every WebSocket frame, and checks the hidden text
isn't in any of it.

### Why a shared document can't just be filtered

The obvious alternative, one document for the whole briefing where the server "leaves out" what a
reader can't see, doesn't work with collaborative editing:

- In Yjs (see [section 2](#2-concurrent-editing)) every character has an identity, and every edit is
  expressed relative to neighbouring characters. A copy that is missing some characters can't
  apply later edits that refer to them. Copies diverge, or the edit history has to carry the
  hidden characters' positions, which leaks their structure and often their content.
- The only safe unit of hiding is a whole document. So hiding has to be built into the document's
  *structure*, not done by filtering its updates.

### Word-level redaction: options considered

Redacting words inside a sentence ("NIGHTJAR is the ████████████████████████") needs a finer
structure. Three designs were considered:

| | How it works | Guarantee | Cost |
|---|---|---|---|
| **1. Spans as documents** | A classified span is its own small collaborative document; the sentence holds an inline placeholder that points to it. Cleared members connect to the span, others see a bar. | Hidden text never leaves the server; cleared members can edit spans inline. | Many tiny documents; a nested editor per span; selections, cursors and undo across span boundaries; copy and paste of partly classified text. Heavy UI work. |
| **2. Server-made projections** | The server holds the full text and derives a redacted copy per clearance level, rewritten on every change. Readers below the top level get their level's copy. | Hidden text never leaves the server. Simple and robust. | Lower-cleared readers can't edit that section: a projection can't take edits back. |
| **3. Encrypted spans** | Everyone receives every span, encrypted with a key per clearance level; cleared clients decrypt. | Relies on key management instead of the server. | Reveals exact lengths; revoking access means re-encrypting; key distribution becomes the hard problem. |

### Built: mark to classify, project to read

A hybrid of 1 and 2 keeps option 2's safety without option 1's editor work.

- **Classifying words is like formatting.** A cleared editor selects words and applies a
  classification mark, the way they'd make text bold. The editor offers only levels up to their own
  clearance, and the server enforces it (below). The Yjs binding stores the mark as a formatting
  attribute, `classified: { level }`, on the text, so the server can read it. Readers cleared for it
  see portion markings: (C), (S), (TS).
- **The full text is for those cleared for every mark.** A section's full text (room
  `section:<id>`) goes only to members whose clearance covers the section's classification *and*
  its highest mark. The server computes that mark from the live document when it's open (the stored
  `max_mark_level` lags saves), and stores it on each save, auditing any change.
- **Everyone else reads a projection.** Room `projection:<id>:<level>` holds a copy the server
  writes itself (`src/realtime/projection.ts`): the same paragraphs, each run of words marked above
  `level` replaced by a bar of black blocks rounded up to a multiple of six characters, and
  adjacent bars merged. It is rebuilt 100 ms after the full text changes. Readers can't write to it,
  and nothing hidden is ever copied into it. The REST briefing tells each reader which room to use
  (`view: full | projection | none`).

**Enforced before each update is applied.** A pre-update hook decodes every incoming update to a
full text, applies it to a scratch copy, and computes the highest mark after it:

- **Above the sender's own clearance:** the update is refused and the sender's connection closed.
  Nobody can hide words they couldn't then read.
- **Above another connected member's clearance:** that member is told and disconnected *before*
  the update is applied, so neither it nor anything typed into the newly classified words reaches
  them. Every page re-fetches the briefing and moves to the projection it now needs.

The trade-off, stated plainly: a member who can't see every word of a section can't edit that
section. They can still edit the sections that are fully within their clearance. This matches how
classified documents are handled on paper: portion markings on the original, sanitized copies for
lower levels.

Rejected along the way: letting lower-cleared readers edit their projection and mapping those edits
back into the full text. That is two-way synchronization between different documents, the problem
CRDTs exist to avoid, and it would be the most fragile part of the system.

## 2. Concurrent editing

### No locks: a CRDT

Collaborative text uses **Yjs**, a CRDT (conflict-free replicated data type). There is no locking
and no "last save wins". Every client and the server hold a copy of the document, apply edits
locally at once, and exchange updates. The CRDT guarantees that copies which have seen the same
set of updates hold the same document, **whatever order the updates arrived in** (strong eventual
consistency).

How Yjs achieves that (its algorithm is YATA):

- **Every inserted character (or run of characters) has a permanent ID:** the client that created
  it and that client's counter. It also records the IDs of its left and right neighbours *at the
  moment it was inserted*. Positions are never numbers like "offset 42", which go stale as soon as
  someone else types.
- **Deleting marks items as deleted** (tombstones) rather than removing them, so later edits that
  refer to them still find their place.
- **Updates are commutative and idempotent,** so applying them in any order, or twice, gives the
  same result.

### Cases

| Situation | Result |
|---|---|
| Two people type at the same spot at the same moment | Both insertions survive. They are ordered by a deterministic rule (neighbour IDs, then client ID), so every copy shows the same order. |
| One person types inside a word another deletes | The deleted characters are tombstoned; the new characters survive, anchored to their neighbours. |
| Both delete the same text | Deleting is idempotent: it is simply deleted. |
| One person formats text another is typing into | Formatting is an attribute on character ranges; both changes apply. |
| One person splits a paragraph where another is typing | Paragraphs are nodes in the same structure (a Yjs XML fragment that the TipTap editor maps to), so the typed text lands in whichever half its neighbours ended up in. |
| Someone edits offline, or their connection drops | The client keeps the updates and sends what the server lacks when it reconnects (the sync protocol compares state vectors). |
| Undo | Per person: undo reverts *your* changes, never a collaborator's. |

The server (Hocuspocus) merges updates like any other copy, relays them to the other connections,
and saves the document. Saves are debounced (1 s, at most 5 s apart) and recorded in the audit log
with the list of editors. If the server stops between saves, clients still hold the edits and send
them again on reconnect.

### What a CRDT doesn't solve

- **It guarantees agreement, not intent.** If two people retype the same word at once, both edits
  survive: "blue" edited to "red" and "green" at the same moment can end up as "redgreen". Every
  real-time editor accepts this; people see it immediately and fix it.
- **Documents only grow.** Tombstones and history accumulate. Yjs garbage-collects deleted content
  it no longer needs, but long-lived documents benefit from periodic compaction (re-encoding the
  current state). Not done yet.
- **Moving text between sections is copy and delete,** because sections are separate documents. A
  concurrent edit to the moved text in its old place isn't carried along.

## 3. Permissions on live connections

### When a connection opens

The client sends its access token in the first WebSocket message (not a cookie, so no other site
can ride on it). The server verifies it, loads the member in a transaction scoped to their
organization (so row-level security applies), and computes their access to that section with the
same policy code as the REST API:

- **No access:** the connection is refused. Nothing is synced.
- **Read:** the connection is **read-only on the server**. Updates it sends are refused, and the UI's
  locked editor is only a courtesy.
- **Edit:** a normal connection.

### When permissions change

Every change that can affect access (roles, clearance, shares, classification, deleted documents
or projects, disabled members) is announced with PostgreSQL `NOTIFY` inside its transaction, so
the notification is delivered only if the change commits. Every server instance `LISTEN`s, and
re-checks its open connections for that organization:

- **Lost access:** the client is told (`access: none`) and disconnected.
- **Demoted:** the connection becomes read-only and the client is told, so its editor locks.
- **Promoted:** the connection becomes writable.
- **Personal `member:<id>` rooms:** these get a "refresh". A member with no access yet learns that
  way when a share arrives.

### The race, and how it's closed

The re-check runs *after* the change commits, so there was a window: between the commit and the
re-check, a demoted editor's connection was still writable. A test shows it: a client that sends
an edit the instant the demotion request returns got that edit accepted, every time.

The fix fails closed and then recovers:

1. **Lock before commit.** The same code that announces the change (`AccessChanges`) first makes
   every live section connection in that organization read-only on this server, before the
   transaction commits. From then on, no update is accepted from anyone until the re-check has
   decided.
2. **Re-check and restore.** After the commit notification, each connection gets its new access.
   Those still allowed to edit become writable again.
3. **Recover what the lock refused.** A refused update isn't resent by the client on its own, so a
   legitimate editor would silently lose what they typed during the lock. When a connection is
   restored, the server starts a sync with it. The client then sends everything the server is
   missing, and nothing is lost.
4. **If the change rolls back,** there is no notification, so a fallback re-check runs after three
   seconds and restores everyone.

Tests cover each part: an edit sent immediately after a demotion never lands (it failed before the
fix), and an edit refused during a lock is recovered afterwards. That second test fails if the
recovery sync is removed.

Remaining limits:

- **Across several server instances,** only the instance that handled the change locks before
  commit. The others lock when the notification arrives, which is milliseconds after the commit
  but not zero. Closing that completely would mean routing each organization's connections to one
  instance, or checking access on every incoming update.
- **A demoted editor's in-flight edits remain on their own screen.** The server refused them, so
  nobody else sees them and they aren't saved, but the demoted client's copy still shows them
  until it reloads.

## 4. Summary of guarantees

| Guarantee | Enforced by | Proven by |
|---|---|---|
| Text above your clearance never reaches your browser | One collaborative document per section; redacted REST responses | Browser test scanning all HTTP and WebSocket traffic |
| Words marked above your clearance never reach you | Full text only for those cleared for every mark; server-written projections | Property test over 500 random documents; realtime tests on the raw document bytes; the browser traffic scan |
| Nobody marks above their own clearance | Pre-update check; the connection is closed | Realtime test (fails with the check removed) |
| Classifying words takes effect before the next keystroke | Uncleared members disconnected before the update is applied | Realtime test with the background re-check disabled (fails without the pre-update disconnect) |
| Readers can't change text | Read-only connections, enforced on the server | Realtime test: a reader's edits reach no one |
| Lost access takes effect on open connections | `NOTIFY` on commit, re-check, disconnect | Realtime tests for demotion, clearance and revoked shares |
| No edit lands after a permission change commits (single instance) | Lock before commit | Realtime test (failed before the fix) |
| Legitimate edits survive a re-check | Recovery sync on restore | Realtime test (fails without the recovery) |
| Concurrent edits converge | Yjs CRDT | Realtime test: edits sync between editors and are saved |
