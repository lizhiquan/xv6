# Chapter 15 — Inodes and the On-Disk Layout

> We have atomic transactions (Chapter 14) over a cached block device (Chapter
> 13). Now we impose structure on those blocks: a superblock describing the disk,
> a bitmap tracking free blocks, and **inodes** — the on-disk objects that *are*
> files. This chapter is where raw blocks become files with sizes, types, and
> content addressed by offset.
>
> Milestone: allocate inodes and read/write file data through them.

---

## 15.1 The disk layout

The file system divides the disk into regions, fixed at format time:

```
 block 0   1            2 .. inodestart    bitmap     data blocks …
┌───────┬─────────┬──────────────────┬───────────┬──────────────────────┐
│ boot  │ super   │     inodes       │  bitmap   │   file/dir contents  │
└───────┴─────────┴──────────────────┴───────────┴──────────────────────┘
```

The **superblock** (block 1) records the geometry — how many blocks, how many
inodes, and where each region starts:

```go
// fs.go
const FSMAGIC = 0x10203040

type superblock struct {
	magic      uint32
	size       uint32 // total blocks
	nblocks    uint32 // data blocks
	ninodes    uint32
	nlog       uint32
	logstart   uint32
	inodestart uint32
	bmapstart  uint32
}
```

Everything else locates itself relative to these fields. The superblock is read
once at boot (`fsInit`) and never changes.

---

## 15.2 The on-disk inode

An **inode** ("index node") is the on-disk description of one file: its type, size,
and the locations of its data blocks. Many inodes pack into one block.

```go
// fs.go
const (
	NDIRECT  = 12
	NINDIRECT = BSIZE / 4 // 256 block numbers fit in one block
	MAXFILE  = NDIRECT + NINDIRECT
)

type dinode struct {
	typ   int16  // T_DIR, T_FILE, T_DEVICE, or 0 = free
	major int16  // device number (T_DEVICE)
	minor int16
	nlink int16  // number of directory entries referring to this inode
	size  uint32 // file size in bytes
	addrs [NDIRECT + 1]uint32 // data block numbers (+ 1 indirect)
}
```

The `addrs` array is the clever part (§15.4). `nlink` counts directory references
— when it hits zero *and* no process has the file open, the inode and its blocks
are freed (§15.6).

---

## 15.3 The block bitmap

Free data blocks are tracked by a **bitmap**: one bit per block, `1` = in use.
Allocation scans for a zero bit, sets it, and returns the block (zeroed):

```go
// fs.go
func balloc(dev uint) uint {
	for b := uint(0); b < sb.size; b += BPB {
		bp := bread(dev, bblock(b, sb)) // the bitmap block covering b
		for bi := uint(0); bi < BPB && b+bi < sb.size; bi++ {
			m := byte(1) << (bi % 8)
			if bp.data[bi/8]&m == 0 { // a free block
				bp.data[bi/8] |= m
				logWrite(bp)          // through the log (Chapter 14)
				brelse(bp)
				bzero(dev, b+bi)      // hand back a clean block
				return b + bi
			}
		}
		brelse(bp)
	}
	panic("balloc: out of blocks")
}
```

`bfree` is the inverse — clear the bit. Both go through `logWrite`, so block
allocation participates in the same crash-safe transactions as everything else.
This is exactly why Chapter 14 came first: the bitmap and the inode that uses a
new block must update atomically, or a crash leaks or double-allocates a block.

---

## 15.4 `bmap`: from file offset to disk block

A file's bytes are stored in scattered disk blocks. `bmap(ip, bn)` answers "which
disk block holds the file's `bn`-th block?", allocating it on demand. The first
`NDIRECT` (12) blocks are named directly in `addrs`; beyond that, `addrs[NDIRECT]`
points to an **indirect block** — a whole block full of 256 more block numbers:

```
inode.addrs:
  [0]  ─► data block 0          ┐
  [1]  ─► data block 1          │ direct: first 12 blocks
   …                            │
  [11] ─► data block 11         ┘
  [12] ─► indirect block ─► [256 more block numbers] ─► data blocks 12..267
```

```go
// fs.go
func bmap(ip *inode, bn uint) uint {
	if bn < NDIRECT {
		addr := ip.addrs[bn]
		if addr == 0 {
			addr = balloc(ip.dev) // allocate on first write
			ip.addrs[bn] = addr
		}
		return addr
	}
	bn -= NDIRECT
	if bn < NINDIRECT {
		// load (or allocate) the indirect block, then index into it
		iaddr := ip.addrs[NDIRECT]
		if iaddr == 0 {
			iaddr = balloc(ip.dev)
			ip.addrs[NDIRECT] = iaddr
		}
		bp := bread(ip.dev, iaddr)
		a := asUint32Slice(bp.data[:])
		addr := a[bn]
		if addr == 0 {
			addr = balloc(ip.dev)
			a[bn] = addr
			logWrite(bp)
		}
		brelse(bp)
		return addr
	}
	panic("bmap: out of range")
}
```

This two-tier scheme is a space/size trade-off: tiny files (the common case) need
no indirect block, while a single indirect block extends the maximum file to
`12 + 256 = 268` blocks. Allocation is **lazy** — a block is allocated only when
the file first writes to that offset, so sparse files cost only what they use.

---

## 15.5 Reading and writing file data

`readi` and `writei` translate a byte range into block operations via `bmap`,
copying through the buffer cache. They handle arbitrary offsets and lengths,
splitting the request at block boundaries:

```go
// fs.go
func readi(ip *inode, dst uintptr, off, n uint) int {
	if off > ip.size { return 0 }
	if off+n > ip.size { n = ip.size - off } // clamp to EOF

	tot := uint(0)
	for tot < n {
		bp := bread(ip.dev, bmap(ip, off/BSIZE))
		m := min(n-tot, BSIZE-off%BSIZE) // bytes within this block
		either_copyout(dst, bp.data[off%BSIZE:off%BSIZE+m]) // to user or kernel
		brelse(bp)
		tot += m; off += m; dst += uintptr(m)
	}
	return int(tot)
}
```

`writei` is symmetric but grows the file: writing past the current end allocates
blocks (via `bmap`) and updates `ip.size`, all under the log. Both use
`either_copyout`/`either_copyin` so the same routine serves a kernel destination
(reading a directory) or a user destination (a `read` syscall) — the user case
routing through `copyout`/`copyin` from Chapter 6.

---

## 15.6 The in-memory inode and its lifecycle

On disk an inode is passive data; in memory the kernel keeps an **inode cache**
(`itable`) of active inodes, each with a reference count and a sleep lock,
mirroring the buffer cache (Chapter 13):

```go
// fs.go
type inode struct {
	dev, inum uint
	ref       int       // in-memory references (iget/iput)
	lock      sleeplock // guards the fields below while loaded
	valid     bool      // have we read the dinode from disk?
	// ... a cached copy of the dinode fields: typ, nlink, size, addrs ...
}
```

The operations form a careful protocol:

- **`ialloc`** finds a free on-disk inode (type 0), marks its type, returns it.
- **`iget`** returns an in-memory inode for `(dev, inum)`, bumping `ref` — but does
  *not* read the disk yet.
- **`ilock`** locks an inode and lazily loads its contents from disk on first use
  (`valid`).
- **`iupdate`** writes the in-memory inode back to disk (through the log).
- **`iput`** drops a reference; if it's the last one *and* `nlink == 0`, the file
  is truly deleted: `itrunc` frees all its data blocks and the inode itself.

The split between `ref` (in-memory references) and `nlink` (on-disk directory
references) is what makes "delete an open file" work correctly: `unlink` can drop
`nlink` to zero, but the inode and its blocks survive until the last process
`iput`s it. This is the classic Unix behavior where a program keeps reading a file
that has already been removed from its directory.

---

## 15.7 What you should take away

- The disk is divided into **superblock, inodes, bitmap, and data**; the
  superblock records the geometry.
- An **inode** holds a file's type, size, link count, and block addresses; many
  pack into a block.
- A file's blocks are found by **`bmap`**: 12 direct blocks plus one indirect
  block (256 more), allocated **lazily** on first write.
- **`readi`/`writei`** translate byte ranges to block operations through the
  buffer cache and the log, serving both kernel and user destinations.
- The kernel caches active inodes with `ref` + sleep lock; **`nlink`** (on-disk
  links) and **`ref`** (open references) together let a removed-but-open file live
  until the last `iput`.

---

## Exercises

1. **Max file size.** With `NDIRECT = 12` and a 1024-byte block, compute the
   largest file the current layout supports. How would adding a *double*-indirect
   block change that?

2. **Lazy allocation.** A program seeks to offset 1 MB in a new file and writes
   one byte. How many data blocks does `bmap` allocate? Why is the file "sparse"?

3. **bitmap + inode atomicity.** Why must `balloc` and the inode update that uses
   the new block be in the *same* transaction? Describe the on-disk corruption if
   a crash split them.

4. **nlink vs. ref.** A process opens `/tmp/x`, then another process `unlink`s it.
   Walk through `nlink`, `ref`, and when the blocks are actually freed. At what
   moment is the data unrecoverable?

5. **Indirect cost.** Reading byte 200,000 of a file requires how many block
   reads (counting the indirect block)? Compare to reading byte 5,000.

---

*Next: **Chapter 16 — Directories and Path Names**, where inodes of type
directory get their contents — name-to-inode mappings — and we implement path
resolution, `link`, and `unlink`.*
