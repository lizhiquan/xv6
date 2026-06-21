# Solutions — Part IV (File System)

> Answers to the exercises in Chapters 12–17.

---

## Chapter 12 — The Disk Driver

**1. Three descriptors.** One request needs three because virtio chains separate
buffers: descriptor 0 = the **request header** (read/write + sector), descriptor 1
= the **data buffer** (1024 bytes), descriptor 2 = the **status byte**. The
*device* writes descriptor 2 (and the data buffer on a read).

**2. Stable addresses.** If the GC moved the data buffer between `QueueNotify` and
completion, the device would still DMA to the **old** physical address — now reused
for something else. On a read it overwrites whatever moved in; on a write it sends
stale bytes. Corruption of unrelated memory and/or the disk.

**3. Sleep, don't spin.** `virtioDiskRW` sleeps so the CPU runs **other processes**
while the (slow) disk works; polling would burn a whole CPU doing nothing.
Chapter 10's `sleep`/`wakeup` and scheduler make yielding possible — the process
blocks on the buffer's address and the completion interrupt wakes it.

**4. Batched completions.** If three requests finish between interrupts, the device
adds three `used` entries and raises one interrupt; the handler loops `while
usedIdx != used.idx`, processing all three. One cursor (`usedIdx`) suffices because
it records exactly how far we've consumed the ring; the device's `used.idx` says
how far it has produced.

**5. Ack ordering.** If you woke sleepers before acknowledging, a second completion
could arrive and the device might not re-raise the interrupt correctly (or you'd
race the status bits). Acknowledging first ensures the device's interrupt state is
clean before you process and wake, so no completion is lost.

---

## Chapter 13 — The Buffer Cache

**1. Single copy.** It's a correctness requirement: two independent buffers for
block 7 mean two caches of the same disk data. If process A modifies its copy and
B modifies its copy, whichever writes last wins and the other's update is lost — a
silent data-corruption bug. One shared buffer + its lock serializes them.

**2. Two locks, two scopes.** `bcache.lock` guards only the list/refcounts — short,
no blocking — so a spinlock fits. `buf.lock` is held **across disk I/O** (in
`bread`), which sleeps; a spinlock can't be held across a sleep (it disables
interrupts, so the completion interrupt could never arrive → deadlock), so it must
be a sleep lock.

**3. The handoff.** `bcache.lock` is released before `acquireSleep(&b.lock)` because
you must never sleep while holding a spinlock (Chapter 9). `acquireSleep` may
block; doing so under `bcache.lock` would freeze the whole cache and risk the
interrupt deadlock.

**4. LRU mechanics.** With `NBUF=3`, read/release 1,2,3 → list (MRU→LRU) is 3,2,1.
Reading 4 needs a victim: `bget` scans from the back (LRU end) and evicts **1**
(least-recently used). Correct, because 1 is the block least likely to be needed
again soon.

**5. refcnt vs. lock.** `refcnt` counts how many *references* exist (e.g. block in
flight + a process about to use it); the sleep lock grants **exclusive use of the
contents** to one holder at a time. So a buffer can have `refcnt = 2` (two parties
care it isn't evicted) while only one holds `b.lock` and touches `data`. `refcnt`
protects against **eviction**; the lock protects the **contents**.

---

## Chapter 14 — Crash Recovery: the Logging Layer

**1. The commit point.** The single deciding write is `writeHead()` with `n > 0`
(step 2 of `commit`). One instruction before it: the log holds the new data but the
header still says `n = 0`, so recovery ignores it — the real blocks are untouched
(transaction didn't happen). One instruction after: `n > 0` is durable, so recovery
will replay and finish installing — the transaction *did* happen.

**2. Idempotence.** `installTrans` must be safe twice because a crash can occur
*during* installation, after commit. On reboot, recovery replays the whole log,
re-installing blocks that were already copied. Copying a log block to its home
again writes identical bytes — harmless — which is why idempotence makes recovery
trivial.

**3. Absorption.** Five writes to the bitmap occupy **one** log slot; the committed
contents are the **final** version (each `logWrite` updates the same `buf`, whose
latest data is read at commit). Without absorption, a transaction would consume a
slot per write and could overflow the log even though it only touches a few
distinct blocks.

**4. Group commit.** Two concurrent `create`s each `beginOp` (incrementing
`outstanding`), do their `logWrite`s into the shared log, and `endOp`. Only when
the *last* `endOp` drops `outstanding` to 0 does `commit` run — once — installing
both creates together. **Two** header writes occur for the pair (the commit write
and the clear write), not four.

**5. Log too small.** `beginOp` blocks if the reservation would exceed `LOGBLOCKS`,
preventing a transaction from logging more blocks than the log can hold — which
would otherwise overwrite the header or earlier log blocks, destroying atomicity.
An operation that tried to exceed the log would have to be split or rejected;
xv6 sizes operations so `MAXOPBLOCKS` always fits.

---

## Chapter 15 — Inodes and the On-Disk Layout

**1. Max file size.** Direct: `12 × 1024 = 12 KB`. Indirect: `256 × 1024 = 256 KB`.
Total **268 KB** (`MAXFILE = 12 + 256` blocks). A double-indirect block would add
`256 × 256 × 1024 = 64 MB`, raising the limit dramatically.

**2. Lazy allocation.** Seeking to 1 MB and writing one byte allocates only the
block(s) actually touched: the one data block at that offset, plus the **indirect
block** if the offset is past the 12 direct blocks (1 MB / 1 KB = block 1024, well
into indirect range). The intervening blocks are never allocated — the file is
**sparse**, costing only what's written, because `bmap` allocates on demand.

**3. bitmap + inode atomicity.** `balloc` (marking a block used) and the inode
update (recording that block in `addrs`) must be one transaction so that, after a
crash, you never have a block marked used but not referenced (a leak) or referenced
but not marked used (later double-allocated → corruption). The log makes both land
together or neither.

**4. nlink vs. ref.** Open `/tmp/x`: `ref` ≥ 1 (process holds it), `nlink` = 1.
Another process `unlink`s it: `nlink` → 0, but `ref` is still ≥ 1, so the inode and
blocks survive. Only when the last process closes (`iput` drops `ref` to 0) **and**
`nlink == 0` does `itrunc` free the blocks. The data is unrecoverable at that final
`iput`.

**5. Indirect cost.** Reading byte 200,000 (block 195, in the indirect range)
requires reading the **indirect block** plus the **data block** = 2 reads. Reading
byte 5,000 (block 4, a direct block) requires **1** read — the block number is in
the inode itself.

---

## Chapter 16 — Directories and Path Names

**1. Self-reference.** Path resolution can't recurse infinitely because it consumes
a path **component per step** and stops when the path is exhausted — it doesn't
follow entries except as directed by the path string. `.` and `..` are ordinary
entries, but resolving e.g. `a/..` just steps into `a` then back to its parent; the
finite path bounds the work.

**2. Two names, one file.** After `link("/a","/b")`, `nlink = 2`. `unlink("/a")`
drops it to 1; the data stays because `/b` still references it. `unlink("/b")` drops
it to 0; now (if no process holds it open) the inode and blocks are freed. Two
names, one inode — classic hard links.

**3. Lock ordering.** `namex` holds at most one inode lock at a time. If it locked
the next directory before releasing the current, two processes resolving crossing
paths (`/a/b` and `/b/a`) could each hold one and wait for the other — a deadlock.
Releasing before descending avoids the lock-ordering cycle.

**4. nameiparent.** `create`/`unlink` need the **parent directory** to add or
remove an entry, plus the final name. `namei` returns the *target* inode, which
doesn't help you edit the directory that contains it — you can't add an entry "to"
an inode, only to its parent directory.

**5. Crash mid-link.** `link` writes: the inode block (the `nlink++`) and the
parent directory block (the new entry), both via `logWrite`. If a crash occurs
after `nlink++` but before `dirlink`, the whole transaction simply never commits
(it's all inside one `beginOp`/`endOp`), so neither change is durable — consistent.
In the *no-crash* failure case (e.g. `dirlink` fails), the code explicitly rolls
back the `nlink++` before `endOp`.

---

## Chapter 17 — The File Descriptor Layer

**1. Three layers.** After `fd2 = dup(fd1)`, the **`struct file`** (with the offset)
is shared, so a read via `fd1` advances the offset `fd2` sees. The **descriptor
table entries** are separate slots that happen to point at the same `struct file`.
The inode is shared too, but the offset lives in the `struct file`.

**2. Redirection from scratch.** For `wc < input.txt`: `close(0)` (free fd 0), then
`open("input.txt", O_RDONLY)` — which returns the lowest free fd, **0**. Order
matters: closing 0 first is what makes the subsequent `open` land in slot 0, so
`wc` reads its stdin from the file.

**3. Everything is a file.** `write(1, "hi", 2)` → `sysWrite` looks up
`p.ofile[1]` (a `fdDevice` file for the console) → `filewrite` dispatches to
`devsw[CONSOLE].write` → `consoleWrite` → `uartPutcSync`. The console was
registered in `devsw` under its major number at `consoleInit` (Chapter 3).

**4. Broken pipe.** `pipewrite` checks `!pi.readopen`; with the read end closed it
returns **−1** (and the process may be killed). This implements the shell behavior
where a producer whose consumer has exited gets a broken-pipe error — e.g.
`yes | head` stops `yes` once `head` closes the pipe.

**5. Offset sharing vs. independence.** After `fork`, parent and child share the
*same* `struct file` for inherited descriptors (refcount bumped), so they share one
offset. Two separate `open`s create two *different* `struct file`s for the same
inode, each with its own offset. The difference is whether the open-file object is
shared or distinct.

---

*Next: [Solutions — Part V](solutions-part5.md).*
