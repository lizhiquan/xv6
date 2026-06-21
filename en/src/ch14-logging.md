# Chapter 14 — Crash Recovery: the Logging Layer

> A file operation often touches several disk blocks — creating a file updates a
> directory, an inode, and a bitmap. If the power fails halfway, the disk is left
> inconsistent: a directory entry pointing at an uninitialized inode, a block
> marked used but unreferenced. The logging layer makes a group of block writes
> **all-or-nothing**: after a crash, either every write in a transaction happened
> or none did. It sits between the file system and the buffer cache.
>
> Milestone: survive a simulated crash mid-write with a consistent file system.

---

## 14.1 The problem: torn multi-block updates

Creating a file `/a` involves, at minimum:

1. allocate an inode (write the inode block),
2. mark it allocated (write a bitmap block),
3. add a directory entry (write a directory block).

These must happen together. If the machine crashes after step 1 but before step
3, the disk has an allocated inode that no directory points to — a leak — or
worse, a half-written directory entry pointing at garbage. Disks only guarantee
that a *single sector* write is atomic; we need atomicity across *many* blocks.

The solution is **write-ahead logging**: don't modify the real blocks in place.
First write all the new block contents to a dedicated **log** region on disk, then
write a single **commit** record. Only after the commit do we copy the blocks to
their real homes. A crash is now harmless at every point:

- Crash before commit → the log is incomplete; on reboot we ignore it. The real
  blocks are untouched.
- Crash after commit, during install → on reboot we *replay* the log, finishing
  the installation. The commit record is the atomic switch.

That single commit write is the trick: one atomic sector write decides whether the
whole transaction counts.

---

## 14.2 On-disk and in-memory structure

The log is a contiguous run of blocks: one **header block** followed by `LOGSIZE`
data blocks. The header records how many blocks the committed transaction holds
and which real block each logged block belongs to.

```go
// log.go
type logHeader struct {
	n     int            // number of blocks in the committed transaction (0 = none)
	block [LOGBLOCKS]int // block[i] = real destination of log block i
}

var log struct {
	lock      spinlock
	start     int        // first log block on disk
	size      int
	outstanding int      // how many file-system ops are in progress
	committing bool      // is a commit happening right now?
	dev       int
	lh        logHeader
}
```

The on-disk header's `n` field is the commit switch: `n > 0` on disk means "a
complete transaction is logged, replay it"; `n == 0` means "nothing to do."

---

## 14.3 The transaction API: `beginOp` / `endOp`

File-system code wraps every operation in `beginOp()` … `endOp()`. Multiple
concurrent operations are batched into one transaction; the commit happens when
the last one finishes:

```go
// log.go
func beginOp() {
	acquire(&log.lock)
	for {
		if log.committing {
			sleep(unsafe.Pointer(&log), &log.lock) // wait out an in-progress commit
		} else if log.lh.n+(log.outstanding+1)*MAXOPBLOCKS > LOGBLOCKS {
			sleep(unsafe.Pointer(&log), &log.lock) // not enough log space; wait
		} else {
			log.outstanding++
			release(&log.lock)
			return
		}
	}
}

func endOp() {
	doCommit := false
	acquire(&log.lock)
	log.outstanding--
	if log.committing {
		panic("log.committing")
	}
	if log.outstanding == 0 {
		doCommit = true
		log.committing = true
	} else {
		wakeup(unsafe.Pointer(&log)) // a slot freed up for a waiting beginOp
	}
	release(&log.lock)

	if doCommit {
		commit()
		acquire(&log.lock)
		log.committing = false
		wakeup(unsafe.Pointer(&log))
		release(&log.lock)
	}
}
```

`beginOp` reserves log space conservatively (each op might write up to
`MAXOPBLOCKS` blocks) and blocks if the log is full or a commit is underway.
Batching means several syscalls' writes commit together — far fewer disk writes
than committing each separately. This is "group commit," and it's why xv6's file
system is reasonably fast despite the logging overhead.

---

## 14.4 `logWrite`: intercepting block writes

Inside a transaction, code never calls `bwrite` directly. Instead it calls
`logWrite(b)`, which records that block `b` must be part of the transaction and
*pins* it in the cache (so it can't be evicted before commit):

```go
// log.go
func logWrite(b *buf) {
	acquire(&log.lock)
	// Absorption: if this block is already in the log, reuse its slot.
	i := 0
	for ; i < log.lh.n; i++ {
		if log.lh.block[i] == int(b.blockno) {
			break
		}
	}
	log.lh.block[i] = int(b.blockno)
	if i == log.lh.n {
		bpin(b) // keep it in the cache until commit
		log.lh.n++
	}
	release(&log.lock)
}
```

The clever part is **absorption**: if a transaction writes the same block twice
(common — the bitmap is touched repeatedly), it occupies just one log slot, and
only the final contents are committed. The data isn't copied here at all; `b`
stays in the buffer cache, and commit reads its current contents later.

---

## 14.5 Commit and recovery

`commit` is the heart. It runs only when `n > 0` and performs the four steps in a
strict order:

```go
// log.go
func commit() {
	if log.lh.n > 0 {
		writeLog()        // 1. copy modified cache blocks into the log region
		writeHead()       // 2. write the header with n>0 — THE COMMIT POINT
		installTrans(false) // 3. copy log blocks to their real homes
		log.lh.n = 0
		writeHead()       // 4. write header with n=0 — log is now empty
	}
}
```

Step 2 is the atomic commit: until the header lands with `n > 0`, a crash leaves
the real blocks untouched. After it, the transaction is durable even if we crash
during step 3 — because recovery will redo step 3.

Recovery runs once at boot, before the file system is used:

```go
// log.go
func recoverFromLog() {
	readHead()              // read the on-disk header
	installTrans(true)      // if n>0, replay: copy logged blocks to their homes
	log.lh.n = 0
	writeHead()             // clear the log
}

func initLog(dev int, sb *superblock) {
	log.start = sb.logstart
	log.size = sb.nlog
	log.dev = dev
	recoverFromLog() // always recover before first use
}
```

`recoverFromLog` simply reinstalls whatever a committed-but-not-fully-installed
transaction left in the log, then clears it. Because installation is **idempotent**
— copying a log block to its home twice is harmless — replaying a partially
installed transaction is safe. That idempotence is what makes crash recovery a few
lines instead of a research project.

---

## 14.6 How a file operation uses it

Putting it together, creating a file looks like:

```go
beginOp()
ip := ialloc(...)     // these internally call logWrite, not bwrite
writei(dirp, entry)   // …
iupdate(ip)           // …
endOp()               // commit happens here if this was the last op
```

Every `bwrite` the file system would have done is replaced by `logWrite`, and the
real disk writes happen all at once inside `commit`. The file-system code in
Chapters 15–16 is written against this API and never worries about crashes — the
log makes correctness *composable*: write each operation as if it's atomic, and it
is.

---

## 14.7 What you should take away

- Multi-block updates must be **all-or-nothing**; disks only make single-sector
  writes atomic, so we need **write-ahead logging**.
- A transaction writes new block contents to the **log**, then a single **commit**
  header (`n > 0`) is the atomic switch; only then are blocks copied to their real
  homes.
- **`beginOp`/`endOp`** bracket transactions and **batch** concurrent operations
  into one group commit; `logWrite` records and pins blocks, with **absorption**
  of repeated writes.
- **Recovery** at boot replays a committed log; installation is **idempotent**, so
  replaying a partial install is safe.
- The file system above is written as if each operation is atomic, and the log
  makes that true.

---

## Exercises

1. **The commit point.** Identify the single disk write that decides whether a
   transaction "counts." What is on disk if the crash happens one instruction
   before it? One instruction after?

2. **Idempotence.** Why must `installTrans` be safe to run twice? Give the crash
   timing that causes the same transaction to be installed twice across a reboot.

3. **Absorption.** A transaction writes the bitmap block five times. How many log
   slots does it use, and which contents get committed? What would break without
   absorption when the log is nearly full?

4. **Group commit.** Two processes each create a file concurrently. Show how
   `beginOp`/`endOp` batch both into one commit. How many header writes occur for
   the pair?

5. **Log too small.** `beginOp` blocks if `n + (outstanding+1)*MAXOPBLOCKS >
   LOGBLOCKS`. Explain the disaster this prevents. What would happen if an
   operation tried to log more blocks than the log can hold?

---

*Next: **Chapter 15 — Inodes and the On-Disk Layout**, where we use these atomic
transactions to build the file system's core: the superblock, the block bitmap,
and inodes with their direct and indirect blocks.*
