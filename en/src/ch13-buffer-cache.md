# Chapter 13 — The Buffer Cache

> The disk driver (Chapter 12) reads and writes raw blocks, but going to the disk
> every time would be ruinously slow, and two processes touching the same block
> would race. The buffer cache solves both: it keeps recently used blocks in
> memory, guarantees only one copy of each block exists, and serializes access to
> each block with a sleep lock. Every layer above — logging, inodes, files — talks
> to the disk *only* through this cache.
>
> Milestone: a working block cache layered over the disk driver.

---

## 13.1 Two jobs: caching and synchronization

The buffer cache (`bio.c` → `bio.go`) does two things at once, and both matter:

1. **Caching.** Disk is slow; RAM is fast. Keep a pool of recently used blocks in
   memory so repeated access to the same block (the root directory, the inode
   bitmap) hits RAM, not the disk.
2. **Synchronization.** There must be **at most one copy of each block** in
   memory. If two processes each cached block 7 independently and both modified
   it, one's changes would vanish. The cache enforces a single shared buffer per
   block, protected by a per-buffer sleep lock.

That second job is the subtle one and the reason the cache is a synchronization
primitive, not just a performance trick.

---

## 13.2 The buffer

Each cached block is a `buf`: the block's identity, its data, a sleep lock, and
bookkeeping for the cache's replacement list.

```go
// buf.go
const BSIZE = 1024 // bytes per block

type buf struct {
	valid bool      // has the data been read from disk?
	disk  int       // is the buffer handed to the device right now? (Chapter 12)
	dev   uint
	blockno uint
	lock  sleeplock  // protects the contents while a process uses the block
	refcnt uint      // how many processes hold a reference
	prev, next *buf  // LRU doubly linked list
	data  [BSIZE]byte
}

var bcache struct {
	lock spinlock     // protects the list and refcnts
	buf  [NBUF]buf
	head buf          // sentinel of the LRU list
}
```

Two locks, two scopes — a recurring kernel idiom:

- **`bcache.lock`** (a spinlock) protects the *cache's metadata*: the LRU list and
  the reference counts. Held briefly.
- **`buf.lock`** (a sleep lock) protects a *block's contents* while a process is
  reading or modifying it. Held across disk I/O, so it must be a sleep lock
  (Chapter 9), not a spinlock.

---

## 13.3 `bget`: find or evict

`bget(dev, blockno)` returns the locked buffer for a block. It first scans for an
existing buffer (the single-copy guarantee); if none, it recycles the
least-recently-used buffer that nobody is holding:

```go
// bio.go
func bget(dev, blockno uint) *buf {
	acquire(&bcache.lock)

	// Is the block already cached?
	for b := bcache.head.next; b != &bcache.head; b = b.next {
		if b.dev == dev && b.blockno == blockno {
			b.refcnt++
			release(&bcache.lock)
			acquireSleep(&b.lock) // wait for whoever's using it
			return b
		}
	}

	// Not cached: recycle the LRU unused buffer (scan from the back).
	for b := bcache.head.prev; b != &bcache.head; b = b.prev {
		if b.refcnt == 0 {
			b.dev = dev
			b.blockno = blockno
			b.valid = false // contents not yet loaded
			b.refcnt = 1
			release(&bcache.lock)
			acquireSleep(&b.lock)
			return b
		}
	}
	panic("bget: no buffers")
}
```

The two loops embody the two jobs: the first guarantees a single shared copy; the
second is the LRU eviction. Note the lock handoff — we drop `bcache.lock` (a
brief spinlock) *before* taking `b.lock` (a sleep lock), because you must never
sleep holding a spinlock (Chapter 9).

---

## 13.4 `bread` and `bwrite`

`bread` is `bget` plus "load from disk if not already valid":

```go
// bio.go
func bread(dev, blockno uint) *buf {
	b := bget(dev, blockno)
	if !b.valid {
		virtioDiskRW(b, false) // read from disk (Chapter 12)
		b.valid = true
	}
	return b // returned locked; caller must brelse() it
}

func bwrite(b *buf) {
	if !holdingSleep(&b.lock) {
		panic("bwrite") // must hold the buffer's lock to write it
	}
	virtioDiskRW(b, true) // flush to disk
}
```

`bread` reads lazily — the disk is touched only on a cache miss, and only once,
because subsequent `bget`s find the now-`valid` buffer. `bwrite` pushes the
in-memory contents back to disk; callers use it (via the log, Chapter 14) after
modifying a block's `data`.

---

## 13.5 `brelse`: release and update LRU

When a process is done with a block, `brelse` unlocks it and decrements the
reference count. If the count hits zero, the buffer is now reusable, and it moves
to the *front* of the LRU list (most recently used):

```go
// bio.go
func brelse(b *buf) {
	if !holdingSleep(&b.lock) {
		panic("brelse")
	}
	releaseSleep(&b.lock)

	acquire(&bcache.lock)
	b.refcnt--
	if b.refcnt == 0 {
		// no one is using it; move to the head (most-recently-used end)
		b.next.prev = b.prev
		b.prev.next = b.next
		b.next = bcache.head.next
		b.prev = &bcache.head
		bcache.head.next.prev = b
		bcache.head.next = b
	}
	release(&bcache.lock)
}
```

Because `bget` scans from the back for victims and `brelse` inserts at the front,
the list naturally orders buffers from most- to least-recently used. The block at
the back is the best eviction candidate. The data of an evicted buffer stays valid
on disk because every modification went through `bwrite` first.

---

## 13.6 The usage pattern

Every higher layer follows the same discipline, which is worth committing to
memory:

```go
b := bread(dev, blockno) // get the block, locked, loaded
// … read or modify b.data …
// (writes go through the log in Chapter 14, which calls bwrite)
brelse(b)                // release it
```

`bread` … `brelse` brackets every block access in the kernel. Holding `b.lock`
for that span is what makes block operations atomic with respect to other
processes: while you hold block 7, no one else can read or write it. This is the
foundation the file system stands on — the inode and directory code in Chapters
15–16 never touch the disk except through `bread`/`brelse`.

---

## 13.7 What you should take away

- The buffer cache does **two jobs**: caching disk blocks in RAM, and guaranteeing
  **exactly one in-memory copy** of each block, serialized by a per-block sleep
  lock.
- **Two locks**: a brief spinlock (`bcache.lock`) for the LRU list and refcounts;
  a sleep lock (`buf.lock`) for a block's contents, held across disk I/O.
- **`bget`** returns the single shared buffer for a block, finding it or evicting
  the LRU unused one; it hands off from spinlock to sleep lock correctly.
- **`bread`** loads lazily (once) on a miss; **`bwrite`** flushes; **`brelse`**
  unlocks and reorders the LRU list.
- Every layer above uses the **`bread` … `brelse`** bracket, which makes block
  access atomic.

---

## Exercises

1. **Single copy.** Why is "at most one buffer per block" a *correctness*
   requirement, not just efficiency? Construct the lost-update bug that two
   independent copies of block 7 would allow.

2. **Two locks, two scopes.** Explain why `bcache.lock` can be a spinlock but
   `buf.lock` must be a sleep lock. What happens if you made `buf.lock` a spinlock
   and held it across `virtioDiskRW`?

3. **The handoff.** In `bget`, why is `bcache.lock` released *before*
   `acquireSleep(&b.lock)`? What rule from Chapter 9 would be violated otherwise?

4. **LRU mechanics.** With `NBUF = 3`, trace the list as you `bread`/`brelse`
   blocks 1, 2, 3, then 4. Which block gets evicted, and why is it the right one?

5. **refcnt vs. lock.** A buffer can have `refcnt > 1` yet only one process holds
   its sleep lock at a time. Explain how both are true, and what `refcnt` protects
   that the sleep lock does not.

---

*Next: **Chapter 14 — Crash Recovery: the Logging Layer**, which sits between the
file system and the buffer cache, making multi-block updates atomic so a crash
mid-write can never corrupt the disk.*
